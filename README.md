# FreeRouter

**Un solo endpoint compatible con OpenAI por delante de 22 proveedores de inferencia
gratuita.** Tú pones las claves; él decide qué modelo usar en cada petición, respeta las
cuotas de cada proveedor para no provocar 429 y hace failover cuando alguno falla.

[![Licencia MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED.svg)](docker-compose.yml)
[![Tests](https://img.shields.io/badge/tests-127%20passing-success.svg)](#tests)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="fr_...")
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hola"}])
```

Metes tus claves una vez, creas una API key eligiendo **rápido / balanceado / calidad**
más las capacidades que necesites (visión, tool use…), y apuntas cualquier cliente
compatible con OpenAI al puerto local.

A partir de ahí el cliente no sabe nada: no elige modelo, no sabe qué proveedor le está
respondiendo y no tiene que gestionar reintentos.

### Por qué

Los proveedores de inferencia gratuita son útiles pero frágiles: cada uno tiene límites
distintos por minuto y por día, se caen, cambian de catálogo y devuelven 429 en el peor
momento. Eso obliga a que cada aplicación cliente sepa qué proveedor usar, qué modelo
pedir y cómo reintentar. FreeRouter le da la vuelta: esa lógica vive en un sitio y las
aplicaciones no se enteran.

### Índice

- [Instalación](#instalación) · [Docker](#docker) · [Contraseña](#contraseña)
- [Usarlo](#usarlo) · [Endpoints](#endpoints)
- [Cómo decide](#cómo-decide) — calidad, velocidad y por qué se miden así
- [Cuotas](#cuotas) · [Proveedores](#proveedores) · [Qué es gratis de verdad](#qué-es-gratis-de-verdad)
- [Configuración](#configuración) · [Seguridad](#seguridad) · [Exponerlo a internet](#exponerlo-a-internet)
- [Listado de modelos](#listado-de-modelos) · [Historial de peticiones](#historial-de-peticiones) · [Calibración](#calibración)
- [Limitaciones conocidas](#limitaciones-conocidas) · [Estructura](#estructura-del-proyecto) · [Tests](#tests)

## Instalación

```bash
git clone https://github.com/David-Raffo/FreeRouter.git
cd FreeRouter
```

Con Docker (recomendado) salta a [Docker](#docker). Para ejecutarlo directamente:

```bash
npm install
npm run build          # compila el panel y el servidor
npm start              # http://localhost:8787/app/
```

Para desarrollo, `npm run dev` levanta el servidor con recarga en caliente; el panel
tiene su propio `npm run dev --workspace=web` en el puerto 5173 con proxy al 8787.

## Docker

```bash
cp .env.example .env
# edita .env y pon una FREEROUTER_PASSWORD

docker compose up -d --build
# panel: http://localhost:8787/app/
docker compose logs -f          # ver el enrutado en vivo
```

Eso es todo: abres el panel, conectas las claves de los proveedores que tengas y creas
tu primera API key.

**Un solo puerto**, el `8787`, con el panel y la API. Se puede publicar porque las dos
cosas van autenticadas: el panel con la contraseña del `.env` y `/v1` con tus API keys
de FreeRouter.

### Contraseña

```
FREEROUTER_PASSWORD=la-que-quieras
```

**Sin ella no arranca.** `docker compose up` falla explicando qué falta, y si la variable
existe pero es demasiado corta, el servidor se para antes de abrir el puerto. No hay
ningún camino que acabe en un panel accesible sin proteger.

Ese es el motivo de que la contraseña vaya en una variable de entorno y no en un
asistente de instalación: por sí sola una variable sería peligrosa —olvidarla dejaría el
panel abierto—, pero si olvidarla impide arrancar, el descuido es imposible. Es el mismo
trato que hace Postgres con `POSTGRES_PASSWORD`.

Para cambiarla, edita el `.env` y `docker compose up -d`. Las sesiones abiertas se caen
solas: la contraseña vigente entra en la firma de la cookie, así que si la cambias porque
alguien más la conocía, su sesión deja de valer sin que haya que hacer nada más.

Si solo lo usas en tu equipo y no quieres contraseña, `FREEROUTER_DISABLE_AUTH=true`.

La base de datos, la clave maestra y las claves cifradas viven en el volumen
`freerouter-data`, así que sobreviven a `docker compose down` (para borrarlas:
`docker compose down -v`).

`server/catalog/` se monta desde el repo, de modo que puedes ajustar los límites de
`limits.json` y reiniciar el contenedor sin reconstruir la imagen.

Variables opcionales, vía `.env` junto al `docker-compose.yml`:

```
ARTIFICIAL_ANALYSIS_API_KEY=aa_...
FREEROUTER_PASSPHRASE=...
```

Para usarlo desde fuera de la máquina, ver [Exponerlo a internet](#exponerlo-a-internet).

## Usarlo

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="fr_...")

respuesta = client.chat.completions.create(
    model="auto",                       # se ignora: lo elige el router
    messages=[{"role": "user", "content": "Hola"}],
)
```

La respuesta trae tres cabeceras: `x-freerouter-model` con el modelo que acabó
atendiendo la petición, `x-freerouter-attempts` con cuántos hicieron falta y
`x-freerouter-router-ms` con lo que tardó FreeRouter en decidir —unos 4 ms, para que
puedas comprobar tú mismo que el tiempo se lo lleva el proveedor y no el router.

### Endpoints

| Endpoint | Para qué |
| --- | --- |
| `POST /v1/chat/completions` | La API clásica de OpenAI. Streaming y no streaming |
| `POST /v1/responses` | La API nueva. Se traduce internamente a la anterior |
| `GET /v1/models` | Devuelve un único pseudo-modelo, `auto` |

Se hablan las dos porque los clientes están repartidos: el SDK de OpenAI usa
`chat.completions` por defecto, mientras que n8n trae activado *Use Responses API* y
LangChain lo activa según cómo se configure. Da igual cuál uses, el enrutado es el mismo.

De `/v1/responses` queda fuera lo que un router de modelos gratuitos no puede dar: las
herramientas integradas (búsqueda web, intérprete de código) las ejecuta OpenAI en su
propia infraestructura y aquí se descartan, y `previous_response_id` se rechaza con un
error claro porque FreeRouter no guarda conversaciones —hay que mandar el historial
entero en `input`, como en la API clásica.

Que `GET /v1/models` devuelva solo `auto` es a propósito: el cliente no elige modelo, esa
es la idea del proyecto. Si tu herramienta te obliga a escoger uno de una lista, escoge
`auto`; si te deja escribirlo, vale cualquier cosa.

## Cómo decide

```
candidatos = modelos que cumplen las capacidades exigidas
           ∩ con contexto suficiente
           ∩ con cuota disponible
           ∩ no en cuarentena

score = (peso_calidad · calidad + peso_velocidad · velocidad) · penalización_por_calidad
```

Las dos componentes se miden en **escala absoluta**, no comparando con el resto de
candidatos. Normalizar contra el grupo —1 al mejor, 0 al peor— tenía dos vicios: en un
grupo de modelos lentos alguno sacaba un 1 de velocidad igualmente, y el más rápido se
llevaba el máximo aunque su ventaja fuese imperceptible.

| Perfil       | Calidad | Velocidad |
| ------------ | ------- | --------- |
| `rapido`     | 0,15    | 0,85      |
| `balanceado` | 0,50    | 0,50      |
| `calidad`    | 0,85    | 0,15      |

- **Velocidad**: combina dos medidas, con el ritmo pesando casi el doble que el arranque,
  y **satura a 200 tok/s**. A ese ritmo una respuesta de cien tokens sale en medio
  segundo; que un modelo vaya a 667 no la hace perceptiblemente mejor. Sin ese techo, la
  velocidad bruta compraba el primer puesto: un modelo de calidad 11 que iba a 667 tok/s
  se colocaba por delante de otros mucho más capaces. El TTFT tiene sus propios límites
  absolutos, 300 ms (todo lo que baje de ahí se percibe igual) y 10 s.
- **Suelo de calidad**: por debajo de **15** de Intelligence Index la puntuación se hunde
  de forma cuadrática — un 11 conserva la mitad, un 1 se queda en la milésima parte. No
  es un filtro: el modelo sigue en la cadena como último recurso, porque uno flojo es
  mejor que ninguno, pero deja de competir por el primer puesto. Hace falta porque en el
  tier gratuito la mediana de calidad es 11: sin suelo, el router acaba en modelos que no
  sirven en cuanto el bueno se queda sin cuota.

  | Métrica | Peso | Por qué |
  | ------- | ---- | ------- |
  | tok/s extremo a extremo | 0,65 | En cuanto la respuesta pasa de un par de frases, el ritmo domina la espera |
  | TTFT    | 0,35 | Manda en respuestas cortas y en autocompletado |

  Al arrancar se calibran todos los modelos con el mismo prompt de tamaño medio (~100
  palabras de respuesta), y a partir de ahí las medidas se refrescan con el tráfico real
  más un sondeo ocasional de los que llevan rato sin usarse.

  **Por qué "extremo a extremo" y no el ritmo del stream.** Medir tokens entre el
  intervalo de streaming (total − TTFT) parece más fino, pero no funciona: varios
  proveedores detrás del proxy de OpenRouter generan la respuesta entera del lado
  servidor y la sueltan de golpe. En esos casos el intervalo de streaming mide la
  *descarga*, no la generación. Medido con el endpoint de diagnóstico:

  | Modelo | eventos en ráfaga (<1 ms) | ritmo del stream | extremo a extremo |
  | ------ | ------------------------- | ---------------- | ----------------- |
  | `ling-3.0-flash-fin:free`      | 74 % | 415 tok/s | 116 tok/s |
  | `lfm-2.5-2.6b:free`            | 63 % | 304 tok/s | 148 tok/s |
  | `nemotron-3-super-120b:free`   |  0 % |  66 tok/s |  53 tok/s |

  El único que transmite token a token de verdad (0 % de ráfaga) es el único cuyas dos
  cifras concuerdan. Sobre el tiempo total da igual dónde bufferice cada proveedor, y
  además es lo que determina cuánto se espera de verdad.

  `POST /api/models/<id>/measure` con `{"providerId":"…"}` devuelve el detalle completo
  de una medición —eventos, huecos entre ellos, proporción de ráfaga— para poder
  auditar cualquier cifra que no cuadre. Cuando el proveedor informa de su propio tiempo
  de generación (Groq manda `usage.completion_time`) también se devuelve, que es la
  única referencia externa contra la que contrastar:

  | Modelo (Groq) | Medido extremo a extremo | Según el propio Groq |
  | ------------- | ------------------------ | -------------------- |
  | `allam-2-7b`        | 606 tok/s | 1410 tok/s |
  | `openai/gpt-oss-20b`| 519 tok/s |  919 tok/s |
  | `qwen/qwen3.8-27b`  | 413 tok/s |  510 tok/s |

  Nuestras cifras son sistemáticamente más conservadoras porque incluyen la ida y vuelta
  de red y el TTFT. Groq va de verdad así de rápido.
- **Calidad**: Intelligence Index de [Artificial Analysis](https://artificialanalysis.ai/).
  El repositorio ya trae medidos los modelos conocidos, así que el perfil `calidad`
  funciona sin configurar nada. Con una clave gratuita en `ARTIFICIAL_ANALYSIS_API_KEY`
  se sincronizan ~630 modelos y la cobertura sube mucho: el panel distingue un valor
  medido (`52`) de una estimación por familia (`~24` en gris).

  Detalles del endpoint que costaron encontrar: el índice viaja anidado en
  `evaluations.artificial_analysis_intelligence_index`, no en la raíz del modelo, y la
  respuesta está paginada — quedarse en la primera página deja fuera dos tercios de los
  datos. La sincronización **fusiona**: nunca borra un valor que ya estuviera en
  `quality.json`.

Las capacidades exigidas no salen solo de la API key: si la petición trae una imagen o
define herramientas, se exigen igualmente aunque la key no las declarara.

## Cuotas

Es la razón de ser del proyecto. Un modelo sin cuota **no entra en la selección**, así
que el 429 se evita antes de provocarlo en vez de reaccionar a él.

| Proveedor  | Límites (semilla)                       | Ámbito     | Cómo se corrige en runtime   |
| ---------- | --------------------------------------- | ---------- | ---------------------------- |
| Groq       | 30 req/min · 1.000 req/día · 8K tok/min | por modelo | cabeceras `x-ratelimit-*`    |
| Cerebras   | 5 req/min · 30K tok/min · 1M tok/día    | por modelo | contadores locales           |
| OpenRouter | 20 req/min · 50 o 1.000 req/día         | por cuenta | `GET /api/v1/key` al validar |

### Cuando el 429 llega de todos modos

El modelo se aparta con un castigo que **crece al repetirse**: un minuto el primero, y el
doble cada vez que vuelve y se lo encuentra otra vez, hasta un tope de seis horas. Una
petición que sale bien lo devuelve al mínimo.

Un castigo fijo no sirve, porque el 429 tapa dos situaciones distintas y no dice cuál es:

- Un pico momentáneo. Los modelos `:free` de OpenRouter van por proveedores compartidos y
  a la hora punta devuelven 429 con el mensaje «Provider returned error» —que no es la
  cuota de OpenRouter, es el de detrás saturado—. En un minuto vuelven.
- Un cubo agotado de verdad, que va a seguir agotado un buen rato.

Con un castigo corto, el segundo caso se reintenta sin parar. Y reintentar no es gratis:
medido sobre tráfico real, un fallo de Groq cuesta 76 ms de mediana pero uno de
OpenRouter 532 ms, siete veces más — y en OpenRouter además gasta una de las 50
peticiones diarias, porque allí **las fallidas también cuentan**. Con un castigo largo,
en cambio, un pico de un minuto te deja sin tu mejor modelo durante horas. Doblar empieza
barato y se pone caro solo con quien demuestra estarlo.

**El castigo se multiplica donde equivocarse sale caro, o donde vamos a ciegas.** Cada
proveedor lleva su `rateLimitPenaltyFactor` en `providers.json`, y hay dos motivos para
subirlo:

- **Reintentar sale caro.** OpenRouter va a 4: un fallo suyo tarda siete veces más que
  uno de Groq y encima gasta una de las 50 peticiones diarias.
- **No conocemos el límite.** Siete proveedores no lo publican (SambaNova, OpenCode, OVH,
  Z.AI, LLM7, Ollama) o tienen uno que no cabe en este catálogo (el tope por modelo de
  ModelScope). Ahí la cuota preventiva es una conjetura y el 429 es la única señal real:
  llegar a él ya significa que la estimación falló, así que van a 2. Con Groq no hace
  falta, porque publica su cuota en cabeceras y el 429 se evita antes de provocarlo.

Es un número del catálogo, no del código: si mañana un proveedor publica sus límites, se
baja ahí y el enrutado no se entera.

| 429 seguidos | Groq (×1) | OpenRouter (×4) |
| --- | --- | --- |
| 1.º | 1 min | 4 min |
| 2.º | 2 min | 8 min |
| 3.º | 4 min | 16 min |
| 4.º | 8 min | 32 min |
| 6.º | 32 min | 2,1 h |
| 8.º | 2,1 h | 6 h (tope) |

Dos límites al castigo: si el proveedor manda `retry-after`, sabe más que nosotros y
manda su cifra —el multiplicador no se le aplica—; y nunca se aparta un modelo más allá
del reinicio diario, porque pasada esa hora la cuota vuelve sola.

### Proveedores

El catálogo vive en `server/catalog/providers.json`. Como todos exponen una API
compatible con OpenAI, un proveedor es **datos, no código**: URL base, formato de clave
y límites. Añadir uno es una entrada en ese JSON. Los dos únicos con lógica propia
—Groq, que informa de su cuota en cabeceras, y OpenRouter, que tiene endpoint de
cuenta— la aportan en `src/providers/overrides.ts`.

| Proveedor | Cuota gratuita | Notas |
| --------- | -------------- | ----- |
| **Groq** | 30 req/min · 1.000 req/día, renovable | El único que publica su cuota en cabeceras |
| **NVIDIA NIM** | ~40 req/min, sin tarjeta | Catálogo grande para prototipar |
| **Google AI Studio** | 10-15 req/min, varía por modelo | ⚠️ Tus prompts pueden usarse para entrenar |
| **SambaNova** | Cuota de desarrollador pequeña | Límites no publicados |
| **Ollama Cloud** | Límites por sesión y semana | No publicados |
| **Cloudflare Workers AI** | 10.000 neuronas/día, reinicio a las 00:00 UTC | Credencial en dos partes: `idDeCuenta:token` |
| **Mistral** | Plan Experiment gratuito | Incluye Codestral con la misma clave |
| **OVHcloud** | 2 req/min sin clave, más con ella | |
| **Z.AI** | Solo modelos Flash | El resto se factura |
| **SiliconFlow** | Modelos a precio cero | Registro con SMS |
| **LLM7** | Tier compartido, **sin clave** | Se conecta con el campo vacío |
| **OpenCode Zen** | Unos pocos modelos gratuitos | ⚠️ Algunos permiten usar tus datos para entrenar |
| **Requesty** | ~200 req/día | Solo se enrutan sus modelos a precio cero |
| **OpenRouter** | 50 req/día (1.000 con 10 $ gastados) | Los fallos también gastan cuota |
| **ModelScope** | 2.000 req/día por cuenta, reinicio cada 24 h | Más cuota diaria que Groq. Plataforma china: peor latencia desde Europa |
| **Pollinations** | 12 req/min con registro gratuito | 280 modelos de texto de 394; el resto son de imagen y audio |
| **Cohere** | 1.000 llamadas/mes · 20 req/min | Claves de prueba: evaluación, no producción |
| **Hugging Face** | 0,10 $/mes en crédito que se renueva | Da para poco; va casi al final de la cadena |
| **Cerebras** | ⚠️ Ya no es gratis | Trial de 5 $ que caduca |
| **Scaleway** | ⚠️ 1M tokens de bienvenida | Crédito que se agota |
| **Alibaba DashScope** | ⚠️ 1M tokens/modelo, 90 días | Crédito con caducidad |
| **Novita** | ⚠️ Sin modelos a precio cero estables | Se incluye por si aparecen |

Los marcados con ⚠️ **no tienen cuota que se renueve**: son créditos que se agotan y
luego facturan. El panel lo avisa en su tarjeta antes de que conectes la clave.

**Los tres últimos se verificaron el 2026-09-06** llamando a sus APIs, no leyendo listas.
Merece la pena contar qué se descartó, porque casi todo lo que circula como «API gratuita»
no lo es:

- **GitHub Models está retirado** desde el 30 de julio de 2026, y las listas curadas de
  «APIs gratuitas permanentes» seguían recomendándolo.
- **DeepSeek, Fireworks y Together** dan crédito de bienvenida de un solo uso, no cuota
  que se renueve. Es la categoría ⚠️ y ya hay bastantes.
- **El tier anónimo de Pollinations ya no existe** en la práctica pese a lo que dicen sus
  propios documentos: la primera petición pasa y las siguientes devuelven 401. Por eso
  aquí figura con token, que sigue siendo gratuito.
- **AI Horde** es gratis de verdad, pero su API es asíncrona, propia y servida por GPUs
  de voluntarios: no es compatible con OpenAI y su latencia es impredecible, justo lo
  que envenena a un router que puntúa por velocidad.
- **DuckDuckGo AI Chat, Cloudflare AI Playground, UncloseAI y similares** son endpoints
  de aplicaciones de consumo obtenidos por ingeniería inversa, no APIs ofrecidas. Igual
  que proxyficar GitHub Copilot o Codex, que son productos de suscripción. Aquí no
  entran: se rompen sin aviso y usarlos va contra las condiciones de quien los paga.

Lo que se comprobó de cada uno el 2026-09-04: que la URL responde y que el listado de
modelos funciona. Los límites exactos cambian a menudo y varios no los publican, así que
`defaultLimits` es solo una semilla conservadora que se corrige en runtime con las
cabeceras y los 429 del propio proveedor.

**Credenciales de dos partes.** Cloudflare mete el id de cuenta dentro de la URL
(`/accounts/{id}/ai/v1`), así que su credencial se pega como `idDeCuenta:token` y se
corta por el primer `:` — el token puede contener más. El descriptor lo declara con
`credentialFormat: "account:token"` y `baseUrlTemplate`; el resto del router no se
entera. Cloudflare tampoco expone `/models` en su ruta compatible con OpenAI (devuelve
405): sus modelos se listan aparte, en `/ai/models/search`, filtrando por la tarea
«Text Generation».

**Cómo se filtra lo que no sirve.** Un catálogo grande trae de todo, y enrutar un chat a
un modelo de embeddings o a un generador de imágenes falla siempre:

- `freeOnly` para los agregadores que mezclan gratis y de pago (OpenRouter, Requesty,
  SiliconFlow): solo pasan los de precio cero confirmado. Un modelo sin precio conocido
  se descarta — mejor perder un modelo que facturar sin querer.
- `model_type` cuando el proveedor lo declara. LLM7 publica 46 modelos: 37 de chat, 6 de
  vídeo y 3 de imagen. Solo entran los 37.
- Patrones de nombre para embeddings, TTS, transcripción y clasificadores.
- **models.dev** cuando el listado del proveedor no basta. OpenCode Zen sirve 70
  modelos y su `/models` solo devuelve el id: sin precio no hay forma de saber cuáles
  son gratis, y ahí dentro hay Claude, GPT y Gemini de pago. models.dev es el catálogo
  abierto que usa el propio OpenCode y publica precio, contexto, modalidades y tool use
  por modelo; cruzándolo con lo que el proveedor sirve de verdad quedan los 8 gratuitos.

  Se activa con `modelsDevKey` en el descriptor, y **solo donde sus precios reflejan el
  tier gratuito**. En los proveedores que cobran por consumo (Cloudflare y sus neuronas)
  models.dev publica tarifas de pago, así que filtrar por ellas dejaría el catálogo
  vacío. El listado del proveedor siempre manda sobre el de models.dev.

### Qué es gratis de verdad

- **Groq** y **OpenRouter** tienen cuota gratuita que se renueva sola. En OpenRouter
  además solo se enrutan los modelos con sufijo `:free` (precio 0 confirmado en su API).
- **Cerebras ya no.** Retiró su tier gratuito el 17 de agosto de 2026: ahora es un trial
  de 5 $ en créditos que caducan a los 30 días y exige método de pago verificado. Al
  agotarse devuelve `402`. El panel lo avisa en su tarjeta antes de que conectes la
  clave, y si responde 402 se marca la cuenta como no utilizable y el tráfico sigue por
  los demás. **Conéctalo solo si aceptas que puede facturarte.**

Los valores de `server/catalog/limits.json` son solo la semilla: mandan las cabeceras
del proveedor. Los contadores diarios se persisten en SQLite, así que reiniciar no
regala cuota ya gastada.

**OpenRouter va al final de la cadena de failover a propósito**: su cuota diaria es de
50 peticiones (1.000 si la cuenta llegó a acumular 10 $ de crédito de por vida) y las
peticiones fallidas también la consumen.

## Configuración

| Variable                       | Por defecto           | Para qué                                              |
| ------------------------------ | --------------------- | ----------------------------------------------------- |
| `FREEROUTER_PASSWORD`          | —                     | **Obligatoria.** Contraseña del panel; sin ella no arranca |
| `FREEROUTER_DISABLE_AUTH`      | `false`               | Quita la contraseña. Solo para uso local              |
| `FREEROUTER_HTTPS`             | `false`               | Marca la cookie de sesión como `secure`               |
| `FREEROUTER_PORT`              | `8787`                | Puerto del panel y de la API                          |
| `FREEROUTER_HOST`              | `127.0.0.1`           | Interfaz de escucha                                   |
| `FREEROUTER_HOME`              | `~/.freerouter`       | Base de datos y clave maestra                         |
| `FREEROUTER_PASSPHRASE`        | —                     | Deriva la clave maestra de una passphrase (scrypt)    |
| `ARTIFICIAL_ANALYSIS_API_KEY`  | —                     | Activa el Intelligence Index real                     |
| `FREEROUTER_DB`                | `<HOME>/freerouter.db`| Ruta del fichero SQLite                               |
| `LOG_LEVEL`                    | `info`                | Verbosidad del log (`debug`, `warn`, `error`…)        |
| `FREEROUTER_BIND`              | `0.0.0.0`             | A qué interfaz se publica el 8787 (solo Docker)       |
| `FREEROUTER_DOMAIN`            | —                     | Dominio para el perfil `https` (Caddy)                |
| `ACME_EMAIL`                   | —                     | Correo de aviso de Let's Encrypt, perfil `https`      |
| `CLOUDFLARE_TUNNEL_TOKEN`      | —                     | Token del túnel, perfil `tunnel`                      |

Los ficheros de `server/catalog/` (`limits.json`, `capabilities.json`, `quality.json`)
son editables a mano y se recargan sin recompilar.

## Seguridad

Tres capas, pensadas para que instalarlo en un servidor sea seguro sin configurar nada.

**1. Contraseña obligatoria** en `FREEROUTER_PASSWORD`, sin la cual no arranca (ver
arriba). Cuando el puerto se abre, la contraseña ya existe: no hay ventana en la que
alguien pueda reclamar la instancia, que es un riesgo que n8n documenta en su propio
asistente de instalación.

La sesión va en una cookie firmada con HMAC, `httpOnly` y `SameSite=Lax`, sin tabla de
sesiones. Ocho intentos fallidos bloquean el acceso cinco minutos.

**2. Cifrado en reposo.** Las claves de proveedor se cifran con AES-256-GCM; la clave
maestra vive en `~/.freerouter/master.key` con permisos restringidos (y ACL propia en
Windows). El panel solo llega a ver los últimos 4 caracteres de cada clave.

### Exponerlo a internet

El login basta para una red local. Para publicarlo en internet falta **HTTPS**, y eso no
lo resuelve la aplicación: sin él, la cookie de sesión y tus API keys viajan en claro.

Hay dos formas, según si tu servidor tiene IP pública o no. Las dos son perfiles de
Docker Compose en este mismo repo: no hay ficheros aparte ni pasos manuales.

**Método 1 — abrir el puerto (`--profile https`).** Es el normal para un VPS: tienes IP
pública y puedes apuntarle un dominio. Caddy se pone delante y pide el certificado de
Let's Encrypt solo, sin cuenta en ningún sitio.

```
# .env
FREEROUTER_PASSWORD=la-que-quieras
FREEROUTER_DOMAIN=freerouter.tudominio.com
ACME_EMAIL=tu@correo.com          # avisos de caducidad; opcional pero recomendable
FREEROUTER_HTTPS=true
FREEROUTER_BIND=127.0.0.1         # el 8787 deja de ser accesible desde fuera
```

```bash
# el dominio debe resolver ya a la IP del servidor, y los puertos 80 y 443 estar abiertos
docker compose --profile https up -d
# panel: https://freerouter.tudominio.com/app/
```

`FREEROUTER_BIND=127.0.0.1` es lo que impide saltarse el HTTPS yendo al `:8787` directo.
El certificado se renueva solo; no hay cron que montar.

**Método 2 — túnel de Cloudflare (`--profile tunnel`).** Para cuando *no* puedes abrir
puertos: un servidor en casa, detrás de CGNAT, o un router que no controlas. La conexión
sale de dentro hacia fuera, así que no hay nada que abrir — a cambio necesitas una cuenta
de Cloudflare (gratuita) y el tráfico pasa por ellos.

En [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → Networks → Tunnels, crea
un túnel, copia el token y apunta el *public hostname* a `http://freerouter:8787`.

```
# .env
FREEROUTER_PASSWORD=la-que-quieras
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
FREEROUTER_HTTPS=true
FREEROUTER_BIND=127.0.0.1
```

```bash
docker compose --profile tunnel up -d
```

**Cuál elegir.** Si tienes IP pública y dominio, el método 1: menos piezas, sin depender
de nadie, y nadie más ve tu tráfico. El método 2 es la respuesta cuando abrir un puerto
no es una opción, no una mejora sobre el 1.

**Solo para una prueba rápida**, sin dominio ni cuentas, vale un túnel efímero contra el
contenedor ya levantado:

```bash
docker run --rm --network host cloudflare/cloudflared:latest tunnel --url http://localhost:8787
```

Da una URL `https://algo-random.trycloudflare.com` que muere al cortar el proceso. Sirve
para probar desde el móvil o desde otro sitio; no para dejarlo puesto.

`FREEROUTER_DISABLE_AUTH=true` quita la contraseña. Solo tiene sentido si el panel está
atado a `127.0.0.1` y nadie más llega a esa máquina.

## Cómo se comporta con proveedores rotos

Aprendido con tráfico real, no en teoría:

- **402 Payment Required** (trial de Cerebras agotado): es un problema de cuenta, así
  que la clave se marca inválida con el motivo visible en el panel y el tráfico sigue
  por los demás. No se reintenta, porque reintentar no lo arregla.
- **401 en un modelo concreto**: algunos modelos de OpenRouter están reservados a
  ciertos clientes y responden 401 aunque la clave sea válida. Antes de dar la clave
  por muerta se revalida; si está bien, se desactiva **solo ese modelo**. Sin esta
  comprobación un modelo raro tumbaría a los otros 17 del proveedor.
- **Continuar la cadena**: *cualquier* error deja pasar al siguiente candidato, un 400
  incluido. En teoría un 400 es culpa de la petición y fallaría igual en todos; en la
  práctica no lo es —OpenCode devuelve 400 con «Upstream request failed: Model is
  unavailable», que es un problema suyo disfrazado—. Si todos los candidatos coinciden en
  rechazarla, entonces sí se devuelve 400 con el motivo, en vez de un 502 genérico.
- **Un proveedor que no admite streaming** no se lleva un fallo por ello. Medir el TTFT
  es un extra nuestro (ver [Medir el TTFT siempre](#medir-el-ttft-siempre)): si lo
  rechaza, se reintenta el mismo modelo sin trocear y queda apuntado para no volver a
  pedírselo. No cuenta como intento fallido ni ensucia su salud.

Los modelos desactivados automáticamente se pueden reactivar desde el panel.

## Limitaciones conocidas

- **Generación de imágenes**: la capacidad existe en el modelo de datos y el filtro
  funciona, pero hoy ningún modelo gratuito de los proveedores soportados genera
  imágenes.
  Al marcar esa casilla el panel avisa de que la key no tendría candidatos, en vez de
  dejar que falle luego con un 503.
- **Cobertura del Intelligence Index**: solo una parte de los modelos gratuitos está
  evaluada por Artificial Analysis (el tier gratuito tira hacia modelos pequeños y
  recién salidos, que son los que menos se evalúan). El resto usa estimación por
  familia, marcada como `~N` en gris en el panel. Una clave gratuita de Artificial
  Analysis amplía la cobertura.
- **Contexto en Cerebras**: no publica el tamaño de ventana en su API. Se usa el valor
  de `capabilities.json` y se corrige solo a la baja cuando un modelo rechaza una
  petición por contexto excedido.
- **Modelos con razonamiento visible**: algunos (qwen3.6-27b) devuelven bloques
  `<think>` dentro de `content`. Es comportamiento del modelo; el router no lo filtra.
- **Failover en streaming**: solo es posible antes de emitir el primer token. Si un
  proveedor falla a mitad del stream, el error se propaga al cliente.

## Listado de modelos

Ordenado y paginado **en el servidor**, no en el navegador. Con un catálogo de miles de
modelos, mandar la lista entera en cada refresco del panel serían megabytes cada pocos
segundos.

El orden es siempre el mismo en dos niveles: primero por estado y después por la métrica
que elijas (velocidad o calidad). Los que no pueden servir caen al fondo, ordenados por
lo grave que sea el problema:

| Estado | Significa |
| ------ | --------- |
| `active` | Enrutable ahora mismo |
| `cooldown` | Esperando tras un 429 |
| `no_quota` | Cuota diaria agotada |
| `quarantined` | Fuera por fallos consecutivos |
| `disabled` | Apagado a mano o por rechazo del proveedor |
| `provider_down` | La cuenta del proveedor no puede servir |

El estado se calcula en el servidor y no en el panel, para que el orden del listado y lo
que se ve en pantalla no puedan discrepar. Un modelo sin medir queda por detrás de los
medidos pero por delante de los rotos: todavía puede servir, solo que aún no se sabe
cómo de bien.

`GET /api/models?sort=speed|quality&page=1&pageSize=25&q=filtro`

## Historial de peticiones

La pestaña **Peticiones** del panel lista las últimas 500 llamadas: qué API key la hizo,
qué modelo acabó atendiéndola, TTFT, tok/s de esa petición concreta, tokens e intentos.
Al pinchar una fila se despliega la cronología, el prompt y la respuesta.

La tabla trae TTFT y **tiempo total** por separado, que no son lo mismo: si la respuesta
llegó de una pieza no hay primer token que cronometrar y el TTFT queda en blanco (ver
[Medir el TTFT siempre](#medir-el-ttft-siempre)).

La **cronología** es lo que explica un TTFT que no cuadra: guarda a qué modelo se
intentó, en qué orden, con qué error y **cuánto tardó cada intento**, más el coste del
propio router.

```
Intentos                              1,4 s perdidos antes de acertar
 1  [rate_limit]  groq/llama-3.3-70b        820 ms
 2  [auth]        cerebras/qwen-3-32b       580 ms
 3  [ok]          nvidia/deepseek-v4-flash  TTFT 420 ms · 2,1 s
```

Sin esto, una petición con 420 ms de TTFT que al cliente le llegó en casi dos segundos
parece una contradicción. El tiempo perdido en los candidatos que fallaron no aparece en
ninguna otra métrica. Solo el que respondió tiene TTFT: los demás no llegaron a emitir
nada, así que poner un número ahí sería inventárselo. La cronología son métricas, no
contenido, de modo que sigue estando aunque el registro de prompts esté apagado.

### Medir el TTFT siempre

Una respuesta que llega de una pieza no tiene «primer token», así que no hay TTFT que
cronometrar. Eso deja fuera a todo cliente que no use streaming —n8n, sin ir más lejos—
y el router se queda sin una de sus dos métricas de velocidad por mucho que se le use.

Por eso, por defecto, **FreeRouter le pide la respuesta troceada al proveedor aunque tu
cliente no lo haya pedido**, cronometra el primer token y vuelve a juntarla antes de
contestar. Lo que recibes es un `chat.completion` idéntico al que habrías recibido de
todos modos; lo único que cambia es que ahora hay TTFT.

Se apaga con la casilla «Medir TTFT siempre» de la pestaña Peticiones.

No cuesta tiempo. Medido sobre 24 peticiones alternando los dos modos contra el mismo
modelo, para que la comparación fuese limpia:

| | ms por token | dispersión (p25-p75) |
| --- | --- | --- |
| Con streaming interno | 2,73 | 0,09 |
| De una pieza | 2,73 | 0,19 |

Es el mismo trabajo del modelo; lo único que cambia es cómo se empaqueta el transporte.

**Y nunca puede provocar un error**, porque medir el TTFT es un extra y no debe costar ni
una petición. Los tres casos:

- El proveedor **ignora** la petición de troceado y contesta de una pieza. Se lee tal
  cual; solo se pierde el TTFT, que ahí no existía.
- El proveedor la **rechaza** con un 400. Se reintenta el mismo modelo sin trocear —no
  se pasa a otro— y queda apuntado para no volver a pedírselo nunca. Ese rechazo no
  cuenta como fallo ni ensucia la salud del modelo. Solo un 400 dispara esto: un 5xx no
  dice nada sobre el streaming, y reintentarlo duplicaría las llamadas a un proveedor
  que ya está fallando.
- El proveedor responde 200 con un stream inservible. Igual: reintento de una pieza y
  apuntado.
- Si el stream no trae `usage`, los tokens se estiman por longitud en vez de perderse:
  si no, se quedarían sin descontar de la cuota diaria y sin tok/s.

Guardar prompts y respuestas está activado por defecto —es lo que hace útil el
historial— pero son datos sensibles que quedan en la base de datos local. Se puede
apagar con la casilla «Guardar prompts y respuestas», y «Purgar contenido» borra los
textos ya guardados conservando las métricas. Cada texto se recorta a 4.000 caracteres
y solo se conservan las últimas 500 peticiones, así que la base de datos no crece sin
control.

## Calibración

Al arrancar, FreeRouter mide **todos** los modelos con el mismo prompt (una respuesta de
unas cien palabras) leído en streaming, y guarda TTFT y tok/s. Sin esa medición inicial
el router ordenaría casi solo por calidad durante un buen rato, porque un modelo sin
datos se queda en la mitad de la escala de velocidad: ni ventaja ni castigo.

Se dispara sola en dos momentos: al arrancar y **al conectar un proveedor**. Lo segundo
importa más de lo que parece: el sondeo periódico mide un modelo cada dos minutos, así
que conectar un proveedor con decenas de modelos tardaría más de una hora en tener datos
y el router decidiría casi a ciegas mientras tanto. El panel solo informa del progreso;
no hay botón porque no hace falta pulsarlo.

La calibración respeta la cuota como cualquier otra petición: si el cubo por minuto de
un proveedor se llena, **espera** al hueco en vez de saltarse el modelo. Para remedirlo
todo desde cero: `POST /api/warmup?force=true`.

**Paralelismo.** Cada proveedor es una API distinta con su propia cuota, así que se
miden en paralelo. Hay un tope global de 6 mediciones simultáneas, y no es arbitrario:
varios streams compitiendo por el mismo ancho de banda y el mismo bucle de eventos hacen
que el ritmo salga más bajo del real. Con seis a la vez el sesgo es despreciable —cada
stream son unos pocos KB/s—.

Ese tope global es el único: un proveedor puede usar las seis ranuras si los demás ya han
terminado. Limitarlo además a dos por proveedor no protegía nada —las cuotas ya se
reservan antes de cada sondeo— y convertía al proveedor con más modelos en el cuello de
botella de todo: en una instalación nueva, NVIDIA trae 68 modelos y tardaba 393 s
mientras el resto acababa en 90 s y cuatro ranuras se quedaban libres.

**Plazo para el primer token.** Aparte del tope total de 2 minutos hay uno de 25 s para
que el modelo *arranque*. Un modelo que no emite nada en ese tiempo no va a elegirse
jamás —la puntuación de velocidad ya da cero a partir de 10 s de TTFT—, así que esperarle
dos minutos solo servía para apuntar lo que ya se sabía: cuatro modelos muertos de NVIDIA
se comían 480 s de los 786 s del proveedor. En cuanto llega el primer token el plazo se
cancela y manda el tope total, para no cortar a un modelo lento pero sano mientras
escribe.

**Orden.** Dentro de cada proveedor se miden primero los de más calidad. La calibración
de un catálogo grande dura minutos y durante ese rato el router decide a medias; que
los candidatos que de verdad va a elegir tengan su medida en los primeros segundos
importa más que el orden del resto de la cola.

Las tres cosas juntas dejan una instalación nueva de 136 modelos en unos 2 minutos, frente
a los casi 7 de antes.

Un detalle que costó encontrar: hay proveedores que mandan la respuesta entera en un
único evento SSE. Midiendo hasta el último evento con contenido, el intervalo de
generación sería cero y no habría tok/s; por eso el intervalo se mide hasta el final del
stream y los tokens se estiman por longitud cuando el proveedor no manda `usage`.

## Tests

```bash
npm test
```

127 tests: scoring por perfil (con la saturación de velocidad y el suelo de calidad),
cuotas —incluida la diferencia entre cubo por modelo y por cuenta, y el castigo creciente
tras un 429—, filtrado por capacidades, disyuntor de salud, autenticación del panel,
traducción de la Responses API en los dos sentidos, rearmado de una respuesta troceada, y
pruebas de extremo a extremo del gateway con `fetch` simulado — entre ellas 10 peticiones
concurrentes repartidas entre tres proveedores sin un solo 429 ni reintento.

`test/http.test.ts` levanta un servidor HTTP **real** en vez de usar `app.inject()`.
Existe porque un bug que abortaba todas las peticiones pasó limpiamente por los tests
de `inject` y solo apareció con curl. Los dobles de `fetch` respetan el `AbortSignal`
por la misma razón: un doble más permisivo que la realidad no prueba nada.

## Estructura del proyecto

```
.
├── server/                  # Node 22 · TypeScript · Fastify 5 · better-sqlite3
│   ├── catalog/             # Datos editables a mano, sin recompilar
│   │   ├── providers.json   #   Los 22 proveedores: URL, formato de clave, límites
│   │   ├── capabilities.json#   Capacidades de los que no las publican
│   │   ├── limits.json      #   Semilla de cuotas
│   │   └── quality.json     #   Intelligence Index cacheado
│   └── src/
│       ├── providers/       # generic.ts construye un proveedor desde su descriptor;
│       │                    # overrides.ts solo para Groq, Cloudflare y OpenRouter
│       ├── routing/         # quota · health · score · select · execute · probe
│       ├── catalog/         # Sincronización con Artificial Analysis
│       ├── routes/          # v1.ts (API pública) · responses-api.ts (traducción de
│       │                    # la Responses API) · admin.ts (panel) · auth.ts
│       ├── crypto.ts        # AES-256-GCM para las claves de proveedor
│       └── db.ts            # SQLite y migraciones idempotentes
├── web/                     # Panel: Vite · React · TypeScript
│   └── src/pages/           # Dashboard (Estado) · Activity (Peticiones)
│                            # Providers · Keys · Auth
├── docker-compose.yml       # Perfiles `https` (Caddy) y `tunnel` (Cloudflare)
└── Caddyfile                # HTTPS automático para el perfil `https`
```

**Añadir un proveedor** es normalmente una entrada en `providers.json`, sin tocar código:
todos exponen una API compatible con OpenAI, así que un proveedor es *datos*. Solo hacen
falta líneas en `overrides.ts` cuando el proveedor se sale del molde — Groq publica su
cuota en cabeceras, Cloudflare lista los modelos en otra ruta, OpenRouter tiene endpoint
de cuenta.

## Contribuir

Los issues y los PR son bienvenidos. Dos cosas que agradezco especialmente:

- **Límites desactualizados.** Los proveedores cambian sus cuotas sin avisar y este
  README envejece. Si encuentras uno mal, `server/catalog/providers.json` es el sitio.
- **Proveedores nuevos** que ofrezcan inferencia gratuita de verdad (cuota que se
  renueva, no crédito de bienvenida).

Antes de mandar un PR, `npm test` en verde. Si tocas enrutado o cuotas, con un test que
falle sin tu cambio.

## Licencia

[MIT](LICENSE) © 2026 David Raffo

---

Datos de calidad de modelos por [Artificial Analysis](https://artificialanalysis.ai/),
usados con atribución según sus condiciones.
