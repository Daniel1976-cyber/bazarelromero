// store.config.js
// ─────────────────────────────────────────────────────────
// Única fuente de verdad de "qué tienda es esta". Todo sale
// de variables de entorno. Este archivo NO cambia entre
// tiendas: lo que cambia es el .env / .env.local de cada una.
// ─────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[store.config] Falta la variable de entorno "${name}". Revisa tu .env.local (usa .env.example como guía).`
    );
  }
  return value;
}

function parseCategories(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) throw new Error('no es un array');
    return parsed;
  } catch (e) {
    console.error('[store.config] STORE_CATEGORIES mal formado, usando lista vacía:', e.message);
    return [];
  }
}

// Acepta una URL completa (https://...) o una ruta local. Si es una ruta
// local y no empieza con "/", se la agrega — evita URLs rotas tipo
// "https://mi-tienda.vercel.applogo.webp" cuando alguien escribe
// STORE_LOGO_PATH="logo.webp" en vez de "/logo.webp".
function normalizarRuta(valor) {
  if (!valor) return '';
  if (/^https?:\/\//.test(valor)) return valor;
  return valor.startsWith('/') ? valor : `/${valor}`;
}

function normalizarRutaLogo(valor) {
  return normalizarRuta(valor) || '/logo.png';
}

// ─── Contraste automático ────────────────────────────────────────────────
// Texto legible sobre los colores de la tienda: blanco u oscuro, según cuál se
// lea mejor. Así un acento amarillo claro no lleva letras blancas ilegibles y
// cualquier tema funciona sin tocar el CSS. Se puede forzar desde el .env con
// STORE_TEXT_ON_PRIMARY / STORE_TEXT_ON_ACCENT / STORE_TEXT_ON_HEADER.
const TEXTO_CLARO = '#ffffff';
const TEXTO_OSCURO = '#111827';

function hexARgb(valor) {
  const m = String(valor || '').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function luminancia([r, g, b]) {
  const lineal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lineal(r) + 0.7152 * lineal(g) + 0.0722 * lineal(b);
}

// Se conserva el blanco mientras contraste al menos 3:1 (el umbral de Material
// Design para texto de interfaz): los colores de marca saturados, como un rojo
// o un verde, siguen con letras blancas. Más claro que eso, pasa a texto oscuro.
function textoLegibleSobreLuminancia(l) {
  return 1.05 / (l + 0.05) >= 3 ? TEXTO_CLARO : TEXTO_OSCURO;
}

function textoLegibleSobre(color) {
  const rgb = hexARgb(color);
  return rgb ? textoLegibleSobreLuminancia(luminancia(rgb)) : TEXTO_CLARO;
}

// Para un degradado: promedio de la luminancia de todos sus colores #hex. Si no
// trae ninguno (colores con nombre, rgb()...) se usa el color de respaldo.
function textoLegibleSobreFondo(fondo, respaldo) {
  const colores = (String(fondo || '').match(/#[0-9a-f]{3,6}\b/gi) || []).map(hexARgb).filter(Boolean);
  if (!colores.length) return textoLegibleSobre(respaldo);
  const media = colores.reduce((suma, c) => suma + luminancia(c), 0) / colores.length;
  return textoLegibleSobreLuminancia(media);
}

export const storeConfig = {
  nombre: process.env.STORE_NAME || 'Mi Tienda',
  slug: process.env.STORE_SLUG || 'mi-tienda',
  slogan: process.env.STORE_SLOGAN || '',
  // SEO (solo los usa el servidor, no se exponen al navegador): título y
  // descripción pensados para buscadores. Si se dejan vacíos se arman solos
  // con el nombre y el eslogan.
  seoTitulo: process.env.STORE_SEO_TITLE || '',
  seoDescripcion: process.env.STORE_SEO_DESCRIPTION || '',
  logo: normalizarRutaLogo(process.env.STORE_LOGO_PATH),
  // Imagen para las vistas previas al compartir el enlace (WhatsApp,
  // Facebook...). Opcional: si se deja vacía se usa el logo. Solo la usa el
  // servidor, no se expone al navegador.
  imagenSocial: normalizarRuta(process.env.STORE_SOCIAL_IMAGE),
  colores: {
    primario: process.env.STORE_COLOR_PRIMARY || '#0f766e',
    acento: process.env.STORE_COLOR_ACCENT || '#f59e0b',
    // Opcional: degradado del header en vez de color plano, ej:
    // "linear-gradient(135deg, #1a3d2b 0%, #2d6a4f 100%)". Si se deja
    // vacío, el header usa "primario" como color sólido de siempre.
    headerGradiente: process.env.STORE_HEADER_GRADIENT || '',
    // Color del texto sobre cada fondo. Vacío = se elige solo (ver arriba).
    textoSobrePrimario: process.env.STORE_TEXT_ON_PRIMARY
      || textoLegibleSobre(process.env.STORE_COLOR_PRIMARY || '#0f766e'),
    textoSobreAcento: process.env.STORE_TEXT_ON_ACCENT
      || textoLegibleSobre(process.env.STORE_COLOR_ACCENT || '#f59e0b'),
    textoSobreHeader: process.env.STORE_TEXT_ON_HEADER
      || textoLegibleSobreFondo(process.env.STORE_HEADER_GRADIENT, process.env.STORE_COLOR_PRIMARY || '#0f766e'),
  },
  // Tipografías del tema (opcional). Si se deja vacío, usa la fuente del
  // sistema como hasta ahora. "fuenteGoogleUrl" es el link de Google Fonts
  // que carga las fuentes elegidas (ver temas/CATALOGO-DE-TEMAS.md).
  fuenteTitulo: process.env.STORE_FONT_TITULO || '',
  fuenteCuerpo: process.env.STORE_FONT_BODY || '',
  fuenteGoogleUrl: process.env.STORE_FONT_GOOGLE_URL || '',
  // wa.me exige el número SOLO con dígitos (sin "+", espacios ni guiones).
  // Si alguien lo escribe como "+52 998 323 8891" en el .env, esto lo
  // limpia solo — así nunca se rompe el link por un error de formato.
  whatsapp: (process.env.STORE_WHATSAPP || '').replace(/[^0-9]/g, ''),
  phone2: (process.env.STORE_PHONE_2 || '').replace(/[^0-9]/g, ''),
  facebook: process.env.STORE_FACEBOOK || '',
  direccion: process.env.STORE_ADDRESS || '',
  horario: process.env.STORE_SCHEDULE || '',
  mostrarTasaCambio: (process.env.STORE_SHOW_EXCHANGE_RATE || 'false').toLowerCase() === 'true',

  // Para tiendas que NO manejan USD en absoluto: el precio que cargan en
  // el admin ya ES el valor en CUP directo, sin tasa ni conversión.
  // Es excluyente con mostrarTasaCambio (no tiene sentido activar las dos).
  soloCup: (process.env.STORE_SOLO_CUP || 'false').toLowerCase() === 'true',

  // Solo se usa UNA vez, para poblar la tabla `categorias` de Supabase la
  // primera vez que la tienda arranca y esa tabla está vacía. Después de eso,
  // las categorías reales se crean y viven en Supabase (el admin las agrega
  // desde el panel), no aquí.
  categoriasIniciales: parseCategories(process.env.STORE_CATEGORIES),

  // Estos SÍ son obligatorios: si faltan, el servidor no debe arrancar
  // con una config incompleta o insegura.
  supabase: {
    get url() { return required('SUPABASE_URL'); },
    get anonKey() { return required('SUPABASE_KEY'); },
    get serviceRoleKey() { return process.env.SUPABASE_SERVICE_ROLE || null; },
    bucket: process.env.SUPABASE_BUCKET || `${process.env.STORE_SLUG || 'tienda'}_images`,
  },

  admin: {
    get password() { return required('ADMIN_PASSWORD'); },
    get token() { return required('ADMIN_TOKEN'); },
  },

  // Solo lo que es seguro exponer al navegador (nunca claves).
  // Nota: "categorias" NO se agrega aquí — api/index.js las agrega desde
  // la tabla `categorias` de Supabase, que es la fuente real y viva.
  public() {
    return {
      nombre: this.nombre,
      slogan: this.slogan,
      logo: this.logo,
      colores: this.colores,
      whatsapp: this.whatsapp,
      phone2: this.phone2,
      facebook: this.facebook,
      direccion: this.direccion,
      horario: this.horario,
      mostrarTasaCambio: this.mostrarTasaCambio,
      soloCup: this.soloCup,
      fuenteTitulo: this.fuenteTitulo,
      fuenteCuerpo: this.fuenteCuerpo,
      fuenteGoogleUrl: this.fuenteGoogleUrl,
    };
  },
};
