import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

import { storeConfig } from '../store.config.js';
import { getLatestRate, setRate } from './services/exchangeRateService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const app = express();
app.set('trust proxy', true); // necesario en Vercel para que req.protocol detecte "https" bien

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ─── Cliente Supabase (público y de servicio) ─────────────────────────────
const supabase = createClient(storeConfig.supabase.url, storeConfig.supabase.anonKey);

// El cliente de servicio (acceso total) solo se crea si existe la clave,
// y SOLO se usa en el backend. Nunca se envía al navegador.
export const supabaseService = storeConfig.supabase.serviceRoleKey
  ? createClient(storeConfig.supabase.url, storeConfig.supabase.serviceRoleKey)
  : null;

// ─── Catálogo en memoria (cache simple) ───────────────────────────────────
let productos = [];

async function cargarProductos() {
  try {
    const { data, error } = await supabase.from('productos').select('*');
    if (error) throw error;

    const rate = storeConfig.mostrarTasaCambio ? await getLatestRate() : 1;

    productos = data.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      // Si la tienda opera SOLO en CUP, "precio" ya es el valor en CUP
      // directo (no hay USD, no hay tasa que aplicar). Si maneja USD+CUP,
      // "precio" es USD y se calcula el CUP con la tasa. Si es solo USD,
      // precio_cup queda en null.
      precio_usd: storeConfig.soloCup ? null : p.precio,
      precio_cup: storeConfig.soloCup
        ? p.precio
        : (storeConfig.mostrarTasaCambio ? Math.round(p.precio * rate) : null),
      categoria: p.categoria,
      subcategoria: p.subcategoria || 'General',
      disponible: p.disponible,
      img: p.img || `https://via.placeholder.com/400x300?text=${encodeURIComponent(p.nombre)}`,
      descripcion: p.descripcion || '',
      // Costo/cantidad: solo para métricas del admin. NUNCA se envían al
      // catálogo público (ver el "sanear" antes de responder /api/products).
      costo: p.costo === null || p.costo === undefined ? null : Number(p.costo),
      cantidad: p.cantidad === null || p.cantidad === undefined ? null : Number(p.cantidad),
    }));
    console.log(`[${storeConfig.nombre}] Cargados ${productos.length} productos desde Supabase`);
  } catch (e) {
    console.error(`[${storeConfig.nombre}] Error al cargar productos desde Supabase:`, e.message);
    // Fallback opcional a un JSON local llamado "seed-productos.json" en la raíz,
    // útil solo para desarrollo si Supabase no responde.
    try {
      const fileData = fs.readFileSync(path.join(projectRoot, 'seed-productos.json'), 'utf8');
      productos = JSON.parse(fileData);
      console.log(`[${storeConfig.nombre}] Fallback: cargados ${productos.length} productos locales`);
    } catch {
      productos = [];
    }
  }
}
// Guardamos la PROMESA (no solo llamamos la función) para poder esperarla
// desde cualquier ruta. Esto evita que, en un arranque "en frío" (Vercel
// apaga el servidor si nadie lo usa y lo prende de nuevo en la próxima
// visita), un pedido llegue y se responda con la lista todavía vacía
// mientras la carga real sigue en curso de fondo.
let productosListos = cargarProductos();

// ─── Categorías (el admin las crea desde el panel) ────────────────────────
let categorias = [];

async function cargarCategorias() {
  try {
    const { data, error } = await supabase.from('categorias').select('*').order('nombre');
    if (error) throw error;

    if (data.length === 0 && storeConfig.categoriasIniciales.length) {
      // Primera vez que arranca esta tienda: siembra la tabla con las
      // categorías del .env, para no obligar a crearlas todas a mano.
      if (supabaseService) {
        const { data: sembradas, error: errorSiembra } = await supabaseService
          .from('categorias')
          .insert(storeConfig.categoriasIniciales)
          .select();
        if (errorSiembra) throw errorSiembra;
        categorias = sembradas;
        console.log(`[${storeConfig.nombre}] Categorías sembradas desde STORE_CATEGORIES (${categorias.length})`);
      } else {
        categorias = storeConfig.categoriasIniciales.map((c) => ({ ...c, activa: true }));
      }
    } else {
      categorias = data;
    }
  } catch (e) {
    console.error(`[${storeConfig.nombre}] Error al cargar categorías desde Supabase:`, e.message);
    categorias = (storeConfig.categoriasIniciales || []).map((c) => ({ ...c, activa: true }));
  }
}
let categoriasListas = cargarCategorias();

function slugify(texto) {
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

// ─── Config pública (la usan index.html / search.html / admin.html) ──────
app.get('/api/config', async (req, res) => {
  await categoriasListas;
  // Si la tabla "anuncio" aún no existe en esta tienda (no se corrió el SQL
  // nuevo), supabase devuelve error pero no lanza excepción: caemos al valor
  // por defecto y la tienda sigue funcionando igual, sin cintillo.
  const { data: anuncioData } = await supabase.from('anuncio').select('mensaje, activo').eq('id', 1).single();
  // El cliente solo ve las categorías activas — las ocultas no aparecen
  // en los filtros ni en el buscador, para no saturar el menú con
  // categorías que la tienda no usa.
  res.json({
    ...storeConfig.public(),
    categorias: categorias.filter((c) => c.activa),
    anuncio: anuncioData || { mensaje: null, activo: false },
  });
});

// Cintillo promocional: el admin guarda/edita/activa el mensaje (fila única).
app.put('/api/admin/anuncio', verifyAdmin, async (req, res) => {
  if (!supabaseService) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado' });
  const { mensaje, activo } = req.body;
  const { error } = await supabaseService.from('anuncio')
    .upsert([{ id: 1, mensaje: mensaje || null, activo: !!activo, actualizado_en: new Date().toISOString() }]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Admin: TODAS las categorías (activas y ocultas), para poder gestionarlas
// y para que el formulario de producto siga permitiendo elegir una
// categoría oculta si hace falta reasignar algo.
app.get('/api/admin/categories', verifyAdmin, async (req, res) => {
  await categoriasListas;
  res.json(categorias);
});

// ─── Catálogo ──────────────────────────────────────────────────────────────
// Quita datos internos del admin (costo, cantidad en stock) antes de que
// cualquier respuesta pública los toque. El cliente NUNCA debe ver esto.
function paraCliente(p) {
  const { costo, cantidad, ...publico } = p;
  return publico;
}

// Público: solo lo disponible. Si no hay inventario, el admin lo oculta con
// el interruptor "disponible" en vez de borrarlo — así el producto sigue
// existiendo en la base de datos y no hay que recrearlo cuando vuelva a haber stock.
app.get('/api/products', async (req, res) => {
  await productosListos;
  res.json(productos.filter((p) => p.disponible).map(paraCliente));
});

// Admin: todo el catálogo (disponible y no disponible, con costo/cantidad), para el dashboard y la edición.
app.get('/api/admin/products', verifyAdmin, async (req, res) => {
  await productosListos;
  res.json(productos);
});

app.get('/api/products/:id', async (req, res) => {
  await productosListos;
  const producto = productos.find((p) => p.id === parseInt(req.params.id, 10));
  if (!producto) return res.status(404).json({ message: 'Producto no encontrado' });
  res.json(paraCliente(producto));
});

app.get('/api/categories', async (req, res) => {
  await productosListos;
  res.json([...new Set(productos.map((p) => p.categoria))]);
});

app.get('/api/subcategories/:category', async (req, res) => {
  await productosListos;
  const subcategorias = [...new Set(
    productos.filter((p) => p.categoria === req.params.category).map((p) => p.subcategoria)
  )];
  res.json(subcategorias);
});

// ─── Tasa de cambio (solo si la tienda la usa) ────────────────────────────
app.get('/api/rate', async (req, res) => {
  if (!storeConfig.mostrarTasaCambio) return res.json({ rate: null });
  try {
    res.json({ rate: await getLatestRate() });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo obtener la tasa de cambio' });
  }
});

// ─── Autenticación admin ───────────────────────────────────────────────────
app.post('/api/validatePassword', (req, res) => {
  const { password } = req.body || {};
  if (password !== storeConfig.admin.password) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  res.json({ success: true, token: storeConfig.admin.token });
});

app.post('/api/logout', (req, res) => res.json({ success: true }));

function verifyAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== storeConfig.admin.token) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ─── CRUD admin de productos ───────────────────────────────────────────────
app.post('/api/admin/products', verifyAdmin, async (req, res) => {
  if (!supabaseService) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado en esta tienda' });
  }
  const { nombre, categoria, subcategoria, precio, disponible, imagen, img, descripcion, costo, cantidad } = req.body;
  const { data, error } = await supabaseService.from('productos').insert([{
    nombre, categoria, subcategoria: subcategoria || 'General',
    precio, disponible: disponible !== false, img: imagen || img, descripcion,
    costo: costo === '' || costo === undefined ? null : costo,
    cantidad: cantidad === '' || cantidad === undefined ? null : cantidad,
  }]).select();
  if (error) return res.status(500).json({ error: error.message });
  await cargarProductos();
  res.json(data);
});

// Extrae la ruta dentro del bucket a partir de la URL pública completa,
// para poder borrar el archivo viejo del Storage cuando se reemplaza.
function extraerRutaStorage(urlCompleta, bucket) {
  if (!urlCompleta) return null;
  const marcador = `/public/${bucket}/`;
  const idx = urlCompleta.indexOf(marcador);
  if (idx === -1) return null;
  return urlCompleta.slice(idx + marcador.length);
}

app.put('/api/admin/products/:id', verifyAdmin, async (req, res) => {
  if (!supabaseService) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado en esta tienda' });
  }
  const { id } = req.params;
  const camposPermitidos = ['nombre', 'categoria', 'subcategoria', 'precio', 'disponible', 'descripcion', 'costo', 'cantidad'];
  const cambios = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) {
      const valor = req.body[campo];
      // costo/cantidad son opcionales: "" (campo vacío en el form) debe
      // guardarse como null, no como texto vacío (rompería la columna numérica).
      cambios[campo] = (campo === 'costo' || campo === 'cantidad') && valor === '' ? null : valor;
    }
  }
  // "imagen" o "img": cualquiera de los dos nombres actualiza la columna img
  if (req.body.imagen !== undefined) cambios.img = req.body.imagen;
  else if (req.body.img !== undefined) cambios.img = req.body.img;

  if (Object.keys(cambios).length === 0) {
    return res.status(400).json({ error: 'No hay campos para actualizar' });
  }

  // Si se va a reemplazar la imagen, guardamos cuál era la vieja ANTES de
  // sobrescribirla, para poder borrarla del Storage después.
  let imagenVieja = null;
  if (cambios.img !== undefined) {
    const { data: actual } = await supabaseService.from('productos').select('img').eq('id', id).single();
    imagenVieja = actual?.img || null;
  }

  const { data, error } = await supabaseService.from('productos')
    .update(cambios)
    .eq('id', id).select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || !data.length) return res.status(404).json({ error: 'Producto no encontrado' });

  // Borrar la imagen vieja del Storage, solo si de verdad cambió. Es
  // "best-effort": si falla el borrado no tumbamos la respuesta — el
  // producto ya se guardó bien, esto es solo limpieza.
  if (imagenVieja && imagenVieja !== cambios.img) {
    const ruta = extraerRutaStorage(imagenVieja, storeConfig.supabase.bucket);
    if (ruta) {
      supabaseService.storage.from(storeConfig.supabase.bucket).remove([ruta])
        .catch((e) => console.error('No se pudo borrar la imagen vieja:', e.message));
    }
  }

  await cargarProductos();
  res.json(data);
});

app.delete('/api/admin/products/:id', verifyAdmin, async (req, res) => {
  if (!supabaseService) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado en esta tienda' });
  }
  const { error } = await supabaseService.from('productos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  productos = productos.filter((p) => p.id !== parseInt(req.params.id, 10));
  res.json({ success: true });
});

// Subida de imagen (requiere service role key)
app.post('/api/admin/upload', verifyAdmin, async (req, res) => {
  if (!supabaseService) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado en esta tienda' });
  }
  try {
    const { imageBase64, filename, mimeType } = req.body;
    if (!imageBase64 || !filename) return res.status(400).json({ error: 'No image provided' });

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalName = `productos/${Date.now()}_${safeName}`;

    const { error } = await supabaseService.storage
      .from(storeConfig.supabase.bucket)
      .upload(finalName, buffer, {
        contentType: mimeType || 'image/jpeg',
        cacheControl: '31536000', // 1 año — seguro porque cada foto nueva tiene nombre único
      });
    if (error) return res.status(500).json({ error: error.message });

    const { data: urlData } = supabase.storage.from(storeConfig.supabase.bucket).getPublicUrl(finalName);
    res.json({ url: urlData.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tasa: fijarla manualmente desde el panel admin
app.post('/api/admin/rate', verifyAdmin, async (req, res) => {
  const { rate } = req.body;
  if (rate == null) return res.status(400).json({ error: 'Rate is required' });
  try {
    await setRate(rate);
    await cargarProductos(); // recalcula precio_cup de todo el catálogo
    res.json({ success: true, rate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Categorías: el admin crea las que necesite (Alimentos, Bebidas, etc.)
app.post('/api/admin/categories', verifyAdmin, async (req, res) => {
  if (!supabaseService) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado en esta tienda' });
  }
  await categoriasListas;
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre de la categoría es obligatorio' });
  }

  const id = slugify(nombre);
  if (!id) return res.status(400).json({ error: 'Ese nombre no es válido' });
  if (categorias.some((c) => c.id === id)) {
    return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
  }

  const { data, error } = await supabaseService
    .from('categorias')
    .insert([{ id, nombre: nombre.trim() }])
    .select();
  if (error) return res.status(500).json({ error: error.message });

  categorias.push(data[0]);
  categorias.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  res.json(data[0]);
});

// Ocultar/mostrar una categoría — no se borra, igual que con los productos.
app.put('/api/admin/categories/:id', verifyAdmin, async (req, res) => {
  if (!supabaseService) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado en esta tienda' });
  }
  await categoriasListas;
  const { id } = req.params;
  const { activa, nombre } = req.body;

  const cambios = {};
  if (typeof activa === 'boolean') cambios.activa = activa;
  if (typeof nombre === 'string' && nombre.trim()) cambios.nombre = nombre.trim();
  if (Object.keys(cambios).length === 0) {
    return res.status(400).json({ error: 'Nada para actualizar (envía "activa" y/o "nombre")' });
  }

  const { data, error } = await supabaseService
    .from('categorias')
    .update(cambios)
    .eq('id', id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  if (!data || !data.length) return res.status(404).json({ error: 'Categoría no encontrada' });

  const idx = categorias.findIndex((c) => c.id === id);
  if (idx !== -1) categorias[idx] = data[0];
  res.json(data[0]);
});

// ─── Pedidos (registrados automáticamente desde el checkout) ─────────────
app.post('/api/pedidos', async (req, res) => {
  if (!supabaseService) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado' });
  const { items, totalUsd, totalCup } = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'El pedido no tiene productos' });
  }
  const { error } = await supabaseService.from('pedidos').insert([{
    items, total_usd: totalUsd ?? null, total_cup: totalCup ?? null, estado: 'pendiente',
  }]);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/admin/pedidos', verifyAdmin, async (req, res) => {
  if (!supabaseService) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado' });
  const { data, error } = await supabaseService.from('pedidos').select('*').order('fecha', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/admin/pedidos/:id', verifyAdmin, async (req, res) => {
  if (!supabaseService) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE no configurado' });
  const { estado } = req.body;
  if (!['pendiente', 'concretado', 'no_concretado'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }
  const { error } = await supabaseService.from('pedidos')
    .update({ estado, actualizado_en: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── Archivos estáticos ────────────────────────────────────────────────────
const publicDir = path.join(projectRoot, 'public');

// Reemplaza los placeholders {{STORE_...}} del HTML con los datos reales de
// esta tienda, para que el título/descripción/imagen sean correctos incluso
// para buscadores y vistas previas de WhatsApp/Facebook (que no ejecutan
// JavaScript, así que lo que hace store-app.js en el navegador no les sirve).
// Escapa texto antes de ponerlo dentro de HTML (título, atributos meta...).
// Los nombres/descripciones de producto los escribe un admin, y la URL de la
// petición la controla quien visita: nada de eso debe poder romper el HTML.
function escaparHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function recortarTexto(texto, max) {
  const limpio = String(texto || '').replace(/\s+/g, ' ').trim();
  if (limpio.length <= max) return limpio;
  return limpio.slice(0, max - 1).trimEnd() + '…';
}

// Solo productos visibles para el cliente: un producto oculto no debe
// filtrar su nombre/foto por las etiquetas meta ni por el sitemap.
function buscarProductoPublico(idCrudo) {
  const id = parseInt(idCrudo, 10);
  if (Number.isNaN(id)) return null;
  const p = productos.find((x) => x.id === id);
  return p && p.disponible ? p : null;
}

// ─── Contenido que el servidor entrega YA escrito en el HTML ─────────────
// Antes la grilla de productos la dibujaba solo JavaScript, así que un
// buscador que no lo ejecute veía una página vacía. Estas funciones
// replican EXACTAMENTE el HTML de renderProductCard (public/js/store-app.js):
// si cambias una, cambia la otra.
const PRODUCTOS_SSR_MAX = 48; // la home trae los primeros; el JS completa el resto

function formatearMonto(valor) {
  if (valor === null || valor === undefined || Number.isNaN(Number(valor))) return '';
  return Number(valor).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatearPrecio(usd, cup) {
  const partes = [];
  if (usd !== null && usd !== undefined) partes.push(`$${formatearMonto(usd)}`);
  if (cup !== null && cup !== undefined) partes.push(`${formatearMonto(cup)} CUP`);
  return partes.join(' / ');
}

// JSON dentro de un atributo onclick='...': hay que escapar & y '.
function jsonParaAtributoServidor(obj) {
  return JSON.stringify(obj).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

// JSON-LD dentro de <script>: se escapa "<" para que un texto con
// "</script>" no pueda cerrar la etiqueta antes de tiempo.
function jsonLdScript(obj, id) {
  const json = JSON.stringify(obj).replace(/</g, '\\u003c');
  const atributos = id ? ` id="${id}" data-ssr="1"` : '';
  return `<script type="application/ld+json"${atributos}>${json}</script>`;
}

function renderTarjetaProducto(p) {
  const nombre = escaparHtml(p.nombre);
  const href = `/search.html?id=${encodeURIComponent(p.id)}`;
  return `
    <div class="product-card" data-id="${escaparHtml(p.id)}">
      <div class="img-wrap">
        <a href="${href}" tabindex="-1" aria-hidden="true"><img src="${escaparHtml(p.img)}" alt="${nombre}" loading="lazy" /></a>
      </div>
      <div class="body">
        <a class="card-nombre" href="${href}">${nombre}</a>
        <div class="price">${formatearPrecio(p.precio_usd, p.precio_cup)}</div>
        <button onclick='StoreApp.addToCart(${jsonParaAtributoServidor(paraCliente(p))})' aria-label="Agregar ${nombre} al carrito">Agregar</button>
      </div>
    </div>
  `;
}

function renderDetalleProducto(p) {
  const nombre = escaparHtml(p.nombre);
  return `
        <div class="img-wrap">
          <img src="${escaparHtml(p.img)}" alt="${nombre}" />
        </div>
        <div>
          <h1>${nombre}</h1>
          <div class="price">${formatearPrecio(p.precio_usd, p.precio_cup)}</div>
          <p class="descripcion">${escaparHtml(p.descripcion)}</p>
          <button onclick='StoreApp.addToCart(${jsonParaAtributoServidor(paraCliente(p))})' aria-label="Agregar ${nombre} al carrito">Agregar al carrito</button>
        </div>
      `;
}

// La home espera el catálogo, pero no más de unos segundos: si el servidor
// "arranca en frío" y Supabase tarda, es mejor entregar la página sin la
// grilla (el JS la completa) que dejar al visitante frente a una pantalla en blanco.
async function esperarProductos(ms = 1500) {
  let temporizador;
  const limite = new Promise((resolve) => { temporizador = setTimeout(resolve, ms); });
  await Promise.race([productosListos, limite]);
  clearTimeout(temporizador);
}

function renderPaginaConMeta(nombreArchivo, req) {
  // Los archivos reales están renombrados con "_" adelante (_index.html,
  // _search.html, _admin.html) — a propósito, para que Vercel NO encuentre
  // un archivo físico en esa ruta y así sí le toque pasar por esta función
  // en vez de servirlo directo como estático (ver notas en vercel.json).
  const archivoFisico = { 'index.html': '_index.html', 'search.html': '_search.html', 'admin.html': '_admin.html' }[nombreArchivo] || nombreArchivo;
  const ruta = path.join(publicDir, archivoFisico);
  const html = fs.readFileSync(ruta, 'utf8');

  const origen = `${req.protocol}://${req.get('host')}`;
  const urlActual = `${origen}${req.originalUrl}`;
  const titulo = storeConfig.nombre; // texto visible del header y alt del logo
  const logoConBarra = storeConfig.logo.startsWith('/') ? storeConfig.logo : `/${storeConfig.logo}`;
  const logoAbsoluto = /^https?:\/\//.test(storeConfig.logo)
    ? storeConfig.logo
    : `${origen}${logoConBarra}`;

  // Título, descripción e imagen que ven buscadores y vistas previas
  // (WhatsApp, Facebook). Por defecto son los de la tienda...
  const eslogan = (storeConfig.slogan || '').trim();
  let tituloPagina = storeConfig.seoTitulo || (eslogan ? `${titulo} | ${eslogan}` : titulo);
  let descripcion = storeConfig.seoDescripcion || eslogan
    || `Catálogo de ${titulo}. Haz tu pedido fácil y rápido por WhatsApp.`;
  // Imagen de la vista previa: la dedicada (STORE_SOCIAL_IMAGE, ideal
  // 1200x630) si la tienda la configuró; si no, el logo como hasta ahora.
  const imagenDedicada = storeConfig.imagenSocial
    ? (/^https?:\/\//.test(storeConfig.imagenSocial) ? storeConfig.imagenSocial : `${origen}${storeConfig.imagenSocial}`)
    : '';
  let imagenSocial = imagenDedicada || logoAbsoluto;
  let usaImagenGrande = Boolean(imagenDedicada); // tarjeta grande solo si es la apaisada

  // ...pero en la ficha de un producto (search.html?id=) usan los DEL
  // PRODUCTO: así al compartir el enlace sale su foto y su nombre.
  const productoFicha = nombreArchivo === 'search.html' && req.query.id
    ? buscarProductoPublico(req.query.id)
    : null;
  if (productoFicha) {
    tituloPagina = `${productoFicha.nombre} | ${titulo}`;
    descripcion = recortarTexto(productoFicha.descripcion, 155)
      || `Compra ${productoFicha.nombre} en ${titulo}. Haz tu pedido fácil y rápido por WhatsApp.`;
    if (productoFicha.img) {
      imagenSocial = /^https?:\/\//.test(productoFicha.img)
        ? productoFicha.img
        : `${origen}${productoFicha.img.startsWith('/') ? '' : '/'}${productoFicha.img}`;
      usaImagenGrande = false; // la foto de un producto puede tener cualquier proporción
    }
  }

  // search.html cumple dos roles distintos: ficha de un producto puntual
  // (?id=, sí vale la pena que Google la indexe) o resultados de una
  // búsqueda de texto libre (no debe competir con la página principal).
  // ── Contenido que el servidor escribe directo en el HTML ──
  const visibles = productos.filter((p) => p.disponible);
  let gridHtml = '';
  let detalleHtml = '';
  let similaresHtml = '';
  let canonicalUrl = '';
  let jsonld = '';

  if (nombreArchivo === 'index.html') {
    gridHtml = visibles.slice(0, PRODUCTOS_SSR_MAX).map((p) => renderTarjetaProducto(p)).join('');
    canonicalUrl = `${origen}/`; // también cuando se entra por /index.html

    const negocio = {
      '@type': storeConfig.direccion ? 'Store' : 'Organization',
      name: titulo,
      url: `${origen}/`,
      logo: logoAbsoluto,
      image: logoAbsoluto,
    };
    if (storeConfig.facebook) negocio.sameAs = [storeConfig.facebook];
    if (storeConfig.whatsapp) negocio.telephone = `+${storeConfig.whatsapp}`;
    if (storeConfig.direccion) negocio.address = { '@type': 'PostalAddress', streetAddress: storeConfig.direccion };
    jsonld = jsonLdScript({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'WebSite', name: titulo, url: `${origen}/` }, negocio],
    });
  } else if (productoFicha) {
    detalleHtml = renderDetalleProducto(productoFicha);
    similaresHtml = visibles
      .filter((p) => p.categoria === productoFicha.categoria && p.id !== productoFicha.id)
      .slice(0, 10)
      .map((p) => renderTarjetaProducto(p))
      .join('');
    canonicalUrl = `${origen}/search.html?id=${productoFicha.id}`;

    const precio = productoFicha.precio_usd ?? productoFicha.precio_cup;
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: productoFicha.nombre,
      image: [imagenSocial],
      description: recortarTexto(productoFicha.descripcion, 300) || productoFicha.nombre,
      sku: String(productoFicha.id),
    };
    if (precio !== null && precio !== undefined) {
      schema.offers = {
        '@type': 'Offer',
        price: precio,
        priceCurrency: productoFicha.precio_usd !== null && productoFicha.precio_usd !== undefined ? 'USD' : 'CUP',
        availability: 'https://schema.org/InStock',
        url: canonicalUrl,
      };
    }
    jsonld = jsonLdScript(schema, 'productSchema');
  }
  const canonicalTag = canonicalUrl ? `<link rel="canonical" href="${escaparHtml(canonicalUrl)}" />` : '';

  // Una URL ?id= que no existe (o es de un producto oculto) NO se indexa.
  const robots = nombreArchivo === 'search.html'
    ? (productoFicha ? 'index, follow' : 'noindex, follow')
    : 'index, follow';

  // Colores, degradado y tipografía inyectados directo en el HTML (no
  // esperan a que JS los aplique) — evita el "flash" de color base y logo
  // vacío que se ve un instante antes de que cargue el JavaScript.
  const colorPrimario = storeConfig.colores.primario;
  const colorAcento = storeConfig.colores.acento;
  const headerGradiente = storeConfig.colores.headerGradiente || colorPrimario;
  const fuenteTitulo = storeConfig.fuenteTitulo || 'inherit';
  const fuenteCuerpo = storeConfig.fuenteCuerpo || 'system-ui, sans-serif';
  const fontLinkTag = storeConfig.fuenteGoogleUrl
    ? `<link rel="stylesheet" href="${storeConfig.fuenteGoogleUrl}" />`
    : '';

  // Una sola pasada: el texto ya sustituido (p. ej. el nombre de un
  // producto) nunca se vuelve a interpretar como placeholder.
  const valores = {
    STORE_TITLE: escaparHtml(titulo),
    PAGE_TITLE: escaparHtml(tituloPagina),
    STORE_DESCRIPTION: escaparHtml(descripcion),
    STORE_OG_IMAGE: escaparHtml(imagenSocial),
    STORE_URL: escaparHtml(urlActual),
    STORE_LOGO: storeConfig.logo,
    STORE_ROBOTS: robots,
    STORE_COLOR_PRIMARIO: colorPrimario,
    STORE_COLOR_ACENTO: colorAcento,
    STORE_TEXTO_SOBRE_PRIMARIO: storeConfig.colores.textoSobrePrimario,
    STORE_TEXTO_SOBRE_ACENTO: storeConfig.colores.textoSobreAcento,
    STORE_TEXTO_SOBRE_HEADER: storeConfig.colores.textoSobreHeader,
    STORE_HEADER_GRADIENTE: headerGradiente,
    STORE_FUENTE_TITULO: fuenteTitulo,
    STORE_FUENTE_CUERPO: fuenteCuerpo,
    STORE_FONT_LINK: fontLinkTag,
    STORE_PRODUCT_GRID: gridHtml,
    STORE_DETALLE_HTML: detalleHtml,
    STORE_DETALLE_DISPLAY: detalleHtml ? 'block' : 'none',
    STORE_SIMILARES: similaresHtml,
    STORE_CANONICAL_TAG: canonicalTag,
    STORE_JSONLD: jsonld,
    STORE_TWITTER_CARD: `<meta name="twitter:card" content="${usaImagenGrande ? 'summary_large_image' : 'summary'}" />`,
  };
  return html.replace(/\{\{(\w+)\}\}/g, (coincidencia, clave) => (clave in valores ? valores[clave] : coincidencia));
}

app.get('/', async (req, res) => {
  await esperarProductos();
  res.send(renderPaginaConMeta('index.html', req));
});
app.get('/index.html', async (req, res) => {
  await esperarProductos();
  res.send(renderPaginaConMeta('index.html', req));
});
app.get('/search.html', async (req, res) => {
  await productosListos; // la ficha necesita el catálogo ya cargado
  res.send(renderPaginaConMeta('search.html', req));
});
app.get('/admin.html', (req, res) => res.send(renderPaginaConMeta('admin.html', req)));

// robots.txt: deja pasar a los buscadores, les pide no rastrear la API (solo
// devuelve JSON) y les indica dónde está el sitemap. El admin ya lleva
// "noindex" en su propia página; no se lista aquí para no anunciar su ruta.
app.get('/robots.txt', (req, res) => {
  const origen = `${req.protocol}://${req.get('host')}`;
  res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${origen}/sitemap.xml
`);
});

// sitemap.xml: la página principal + una entrada por cada producto visible.
// Es la forma de que Google descubra las fichas, que hoy no tienen enlaces.
app.get('/sitemap.xml', async (req, res) => {
  await productosListos;
  const origen = `${req.protocol}://${req.get('host')}`;
  const urls = [`${origen}/`]
    .concat(productos.filter((p) => p.disponible).map((p) => `${origen}/search.html?id=${p.id}`));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escaparHtml(u)}</loc></url>`).join('\n')}
</urlset>
`;
  res.type('application/xml').send(xml);
});

// Evita el 404 de favicon.ico que piden algunos navegadores por su cuenta,
// aunque ya exista el <link rel="icon"> apuntando al logo.
app.get('/favicon.ico', (req, res) => res.redirect(storeConfig.logo));

app.use(express.static(publicDir));

export default app;
