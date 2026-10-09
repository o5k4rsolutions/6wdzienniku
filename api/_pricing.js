// api/_pricing.js – jedyne źródło prawdy o cenach i rabatach (liczone po stronie serwera).
// Plik z prefiksem "_" nie jest wystawiany przez Vercel jako endpoint.

class PricingError extends Error {}

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Promocja działa tylko gdy is_discounted = true i cena promocyjna jest niższa od zwykłej
function unitPrice(p) {
  const base = parseFloat(p.price) || 0;
  const d = parseFloat(p.discount_price);
  return p.is_discounted === true && !isNaN(d) && d >= 0 && d < base ? r2(d) : r2(base);
}

async function computePricing(supabase, items, couponCode) {
  if (!Array.isArray(items) || items.length === 0) throw new PricingError('Koszyk jest pusty.');

  // Łączymy duplikaty; z klienta bierzemy WYŁĄCZNIE id i ilość
  const qtyById = new Map();
  for (const it of items) {
    const id = String(it.id || it.product_id || '');
    if (!id) continue;
    const q = Math.max(1, parseInt(it.quantity) || 1);
    qtyById.set(id, Math.min(99, (qtyById.get(id) || 0) + q));
  }
  if (qtyById.size === 0) throw new PricingError('Koszyk jest pusty.');

  const { data: products, error } = await supabase.from('products').select('*').in('id', [...qtyById.keys()]);
  if (error) throw new Error('Nie udało się pobrać produktów: ' + error.message);

  const lines = [];
  for (const [id, quantity] of qtyById) {
    const p = (products || []).find(x => String(x.id) === id);
    if (!p || p.is_active === false || p.active === false) {
      throw new PricingError('Jeden z produktów w koszyku jest już niedostępny. Odśwież koszyk.');
    }
    lines.push({ id, title: p.title || '', category: p.category || '', price: unitPrice(p), quantity, product: p });
  }

  const subtotal = r2(lines.reduce((s, l) => s + l.price * l.quantity, 0));

  let coupon = null;
  let discount = 0;
  if (couponCode) {
    const { data: c } = await supabase
      .from('coupons').select('*')
      .eq('code', String(couponCode).trim().toUpperCase())
      .maybeSingle();

    if (!c) throw new PricingError('Kod rabatowy jest nieprawidłowy.');
    if (c.valid_until && new Date(c.valid_until) < new Date()) throw new PricingError('Ten kod rabatowy wygasł.');
    if (c.usage_limit != null && (c.used_count || 0) >= c.usage_limit) throw new PricingError('Limit użyć tego kodu został wyczerpany.');
    const min = parseFloat(c.min_order_amount) || 0;
    if (min > 0 && subtotal < min) throw new PricingError(`Minimalna kwota zamówienia dla tego kodu to ${min} PLN.`);

    const pids = (c.product_ids || []).map(String);
    const eligible = r2(lines
      .filter(l => (!c.category_restriction || l.category === c.category_restriction) && (!pids.length || pids.includes(l.id)))
      .reduce((s, l) => s + l.price * l.quantity, 0));

    if (c.discount_type === 'percent') discount = eligible * (parseFloat(c.discount_value) || 0) / 100;
    else if (c.discount_type === 'amount') discount = Math.min(eligible, parseFloat(c.discount_value) || 0);
    else if (c.discount_type === 'threshold_reward') {
      const th = parseFloat(c.step_threshold) || 0, rw = parseFloat(c.step_reward) || 0;
      if (th > 0 && rw > 0) discount = Math.floor(eligible / th) * rw;
    }
    discount = r2(Math.min(Math.max(discount, 0), subtotal));
    if (discount <= 0) throw new PricingError('Ten kod nie dotyczy produktów w Twoim koszyku.');
    coupon = c;
  }

  return { lines, subtotal, discount, total: r2(Math.max(0, subtotal - discount)), coupon };
}

// Nadaje dostęp do plików (tabela user_accesses) – tak samo jak robił to create-free-order
async function grantAccess(supabase, userId, orderId, products) {
  const now = new Date().toISOString();
  const rows = [];
  for (const p of products) {
    let files = p.download_files;
    if (typeof files === 'string') { try { files = JSON.parse(files); } catch { files = null; } }
    if (p.product_type === 'eproduct' && Array.isArray(files) && files.length) {
      for (const f of files) {
        rows.push({ user_id: userId, order_id: orderId, product_id: p.id, title: f.name || p.title, file_type: f.type || 'zip', download_url: f.url, created_at: now });
      }
    } else {
      rows.push({ user_id: userId, order_id: orderId, product_id: p.id, title: p.title, file_type: p.file_type || null, download_url: p.download_url || null, created_at: now });
    }
  }
  if (rows.length) {
    const { error } = await supabase.from('user_accesses').insert(rows);
    if (error) throw error;
  }
}

// Pozycje zamówienia w kształcie zgodnym z dotychczasowym: pełny produkt + quantity + applied_price
function orderItems(lines) {
  return lines.map(l => ({ ...l.product, price: l.price, applied_price: l.price, quantity: l.quantity }));
}

module.exports = { computePricing, PricingError, unitPrice, r2, grantAccess, orderItems };
