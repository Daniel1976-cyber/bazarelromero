# Plantilla de tienda online

Un solo código fuente para todas tus tiendas. Lo único que cambia entre una
tienda y otra es el archivo `.env.local`, el logo, y el proyecto de Supabase.
**Nunca edites `public/_index.html`, `_search.html`, `_admin.html` ni `api/index.js`
para adaptarlos a una tienda concreta** — si te hace falta un campo nuevo,
se agrega al `store.config.js` una sola vez y sirve para todas.

## Crear una tienda nueva (checklist)

1. **Duplica esta carpeta** con el nombre de la nueva tienda.
2. **Crea un proyecto nuevo en [supabase.com](https://supabase.com)** (uno por tienda, no lo compartas con otras).
   - Ve a *SQL Editor* y ejecuta `sql/schema.sql`.
   - Ve a *Storage* y crea un bucket público con el mismo nombre que pondrás en `SUPABASE_BUCKET`.
   - Copia `Project URL`, `anon public key` y `service_role key` desde *Settings → API*.
3. **Copia `.env.example` a `.env.local`** y completa todos los valores:
   nombre, whatsapp, colores, categorías, credenciales de Supabase, contraseña de admin.
4. **Reemplaza `public/logo.png`** por el logo real de la tienda (mismo nombre de archivo).
5. Prueba localmente:
   ```bash
   npm install
   npm run dev
   ```
   Abre `http://localhost:3000`.
6. **Sube el repo a GitHub** — asegúrate de que `.env.local` NO se suba (ya está en `.gitignore`).
7. **Despliega en Vercel** e importa el repo. En *Settings → Environment Variables*
   de Vercel, agrega las mismas variables que pusiste en `.env.local` (Vercel no
   lee `.env.local`, solo tu máquina).
8. Listo. Cero líneas de código tocadas.

## Por qué esto resuelve tu problema original

- `index.html`, `search.html` y `admin.html` son **idénticos** en todas las tiendas:
  al cargar, piden su propia configuración a `/api/config` y se pintan solos
  (nombre, logo, colores, categorías, WhatsApp, si muestran tasa o no).
- El buscador y la tasa de cambio (lo que hoy solo tiene Quiroga Express) están
  incluidos **por defecto** en la plantilla. Si una tienda no necesita tasa,
  simplemente pones `STORE_SHOW_EXCHANGE_RATE="false"` y desaparece de la interfaz
  sin tocar HTML.
- Las claves de Supabase y el token de admin viven **solo** en variables de
  entorno — `store.config.js` revienta el arranque si falta alguna, así nunca
  queda una clave hardcodeada "por si acaso" dentro del código (que es lo que
  pasaba en `mercy` y `Quiroga-Express`).

## Seguridad: qué corregir en los repos viejos

`mercy/server-local.js` y la versión vieja de `Quiroga-Express/api/index.js`
tienen las claves de Supabase escritas directamente en el código como
"fallback". Si esos repos son públicos en GitHub, cualquiera puede leerlas
del historial de commits (borrarlas del archivo actual no alcanza, siguen en
el historial). Pasos:

1. En el dashboard de Supabase de cada proyecto viejo: *Settings → API →
   Regenerate* tanto la `anon key` como la `service_role key`.
2. Cambia `ADMIN_PASSWORD` y `ADMIN_TOKEN` también, por las mismas razones.
3. A partir de ahora, esas claves solo viven en las variables de entorno de
   Vercel / tu `.env.local`, nunca en un archivo versionado.

## Estructura

```
tienda-template/
├── store.config.js        # única fuente de verdad de "qué tienda es esta"
├── api/index.js            # backend Express genérico (productos, carrito, admin, tasa)
├── api/services/exchangeRateService.js
├── public/
│   ├── _index.html          # catálogo + buscador + tasa (genérico) — se sirve en "/"
│   ├── _search.html         # resultados de búsqueda (genérico) — se sirve en "/search.html"
│   ├── _admin.html          # panel admin (genérico) — se sirve en "/admin.html"
│   ├── css/styles.css       # usa variables --color-primario/--color-acento
│   └── js/store-app.js      # branding, carrito, buscador (compartido)
├── sql/schema.sql           # tablas a crear en cada Supabase nuevo
├── .env.example             # plantilla de datos por tienda
└── vercel.json
```

**¿Por qué los archivos HTML tienen `_` adelante?** No es un capricho — es
necesario para que funcionen los metadatos (título, colores, SEO) que el
servidor rellena automáticamente. En Vercel, un archivo físico llamado
`index.html` dentro de `public/` se sirve directo como estático, **antes**
de que se consulten las reglas de `vercel.json` — así que el servidor
nunca llegaría a rellenar esos datos. Renombrarlos con `_` hace que no
exista ningún archivo que le "gane" a la regla de ruteo, y el servidor sí
llega a procesarlos. Sigue editándose el archivo igual que siempre —
`_index.html` para la página principal, etc. — solo cambia el nombre, no
el contenido ni cómo se edita.


## SEO (qué hace la plantilla por ti)

- **Título y descripción propios** para Google: variables opcionales
  `STORE_SEO_TITLE` y `STORE_SEO_DESCRIPTION`. Si las dejas vacías se arman
  con el nombre y el eslogan. Escribe qué vendes y dónde, en 120-160 caracteres.
- **Cada producto tiene su propia vista previa**: al compartir
  `/search.html?id=12` por WhatsApp o Facebook sale la foto y el nombre de ese
  producto, no el logo de la tienda. Los productos ocultos nunca se muestran.
- **`/sitemap.xml`** (home + todos los productos visibles) y **`/robots.txt`**
  se generan solos. Después de desplegar, da de alta la tienda en
  [Google Search Console](https://search.google.com/search-console) y envía
  el sitemap.
- Una ficha con `?id=` inexistente o de un producto oculto lleva `noindex`.
- Encabezados correctos: el nombre de la tienda es el `<h1>` de la home y el
  nombre del producto es el `<h1>` de su ficha.

### SEO fase 2: contenido que el buscador ya ve sin ejecutar JavaScript

- **La home viene con los productos escritos en el HTML** (los primeros 48,
  constante `PRODUCTOS_SSR_MAX` en `api/index.js`). El navegador completa el
  resto y quita lo que ya no esté disponible, sin redibujar lo que ya se ve.
  Si el servidor arranca en frío y Supabase tarda más de ~1.5 s, la home se
  entrega igual sin la grilla (el JS la completa) en vez de dejar la pantalla
  en blanco.
- **Cada producto es un enlace real** (foto y nombre llevan a su ficha), y la
  ficha trae escritos en el HTML su nombre, precio, descripción y hasta 10
  productos similares.
- **`<link rel="canonical">`** en la home y en cada ficha (también cuando se
  entra por `/index.html`). Las búsquedas de texto no llevan canonical.
- **Datos estructurados (JSON-LD) desde el servidor**: la home publica
  `WebSite` y la tienda (`Store` si configuraste `STORE_ADDRESS`, si no
  `Organization`, con teléfono de WhatsApp y Facebook si los tienes); cada
  ficha publica un `Product` con precio y disponibilidad.

**Si modificas el diseño de una tarjeta de producto**, cambia los DOS sitios
donde se genera, o la página parpadeará al cargar: `renderProductCard` en
`public/js/store-app.js` (navegador) y `renderTarjetaProducto` en
`api/index.js` (servidor). Lo mismo con la ficha (`renderDetalleProducto`).

### Imagen para compartir el enlace (opcional)

`STORE_SOCIAL_IMAGE` es la imagen que aparece en la vista previa cuando alguien
comparte la tienda por WhatsApp o Facebook. Si la dejas vacía se usa el logo.

- Ponla dentro de `public/` (ej. `public/social.jpg`) y escribe `social.jpg`,
  o usa una URL completa.
- **1200 × 630 px**, JPG o PNG (mejor que WebP), menos de 300 KB, con el logo y
  el nombre en el centro (algunas plataformas recortan los bordes).
- Con esta imagen la tarjeta se muestra grande. Las fichas de producto siguen
  usando la foto del producto; si un producto no tiene foto, usa esta imagen.
- WhatsApp y Facebook guardan las vistas previas: si cambias la imagen, los
  enlaces ya compartidos pueden seguir mostrando la anterior un tiempo.
