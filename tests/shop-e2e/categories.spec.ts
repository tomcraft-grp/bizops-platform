// Product categories in the back office, in a real Chrome against a FAKE backend: fakeBackend.ts plus a small fake of the category functions and the SKU feed below.
// The fake mirrors the contracts that supabase/tests/product_categories.sql proves against the real database (35/35, rolled back). THIS file proves the SCREENS:
// the Categories page (list, create, deactivate with a reason), and on Products the category is chosen from the registered list only (never typed), filtered, and
// sent to the registry. It also proves the app still works on a database without the migration (old free-text field, explanatory banner).
import { expect, test, type Page, type Route } from '@playwright/test';
import { FakeShop } from './fakeBackend';

test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
const HOST = 'hlvravynjalculvplrxc.supabase.co';
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
const POD = 'aaaaaaaa-0000-4000-8000-000000000001', PUFF = 'aaaaaaaa-0000-4000-8000-000000000002', COIL = 'aaaaaaaa-0000-4000-8000-000000000003', KRATOM = 'aaaaaaaa-0000-4000-8000-000000000004';

type Cat = { id: string; code: string; name_th: string; name_en: string | null; description: string | null; parent_id: string | null; is_group: boolean; is_active: boolean; sort_order: number; product_count: number; active_product_count: number; created_at: string; updated_at: string };
const mk = (o: Partial<Cat>): Cat => ({ id: '', code: '', name_th: '', name_en: null, description: null, parent_id: null, is_group: false, is_active: true, sort_order: 100, product_count: 0, active_product_count: 0, created_at: '', updated_at: '', ...o });

class FakeCategories {
  installed = true;
  cats: Cat[] = [
    mk({ id: POD, code: 'POD', name_th: 'POD / บุหรี่ไฟฟ้า', name_en: 'POD / vape', is_group: true, sort_order: 10 }),
    mk({ id: PUFF, code: 'Puff', name_th: 'Puff', parent_id: POD, product_count: 1 }),
    mk({ id: COIL, code: 'Coil', name_th: 'Coil', parent_id: POD }),
    mk({ id: KRATOM, code: 'Kratom drink', name_th: 'Kratom drink', product_count: 1 }),
  ];
  rows = [this.reg('FG-000001', 'BRAND Grape 20000', PUFF), this.reg('FG-000002', 'Kratom bottle', KRATOM)];
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  reg(code: string, name: string, catId: string) {
    const c = () => this.cats?.find((x) => x.id === catId);
    return { sku_code: code, legacy_sku_code: null, sku_category: 'FG', origin: 'import', name_full: name, brand: 'BRAND', product_type: c()?.code ?? null, domain: 'POD / vape (Ref POD)', pack_qty: null, unit_en: null, unit_th: null,
      barcode: null, status: 'active', cost_price: 100, retail_price: 200, selling_price: 200, friend_price: null, wholesale_price: null, ecommerce_price: null, needs_review: false, review_notes: null,
      updated_at: new Date().toISOString(), category_id: catId, get category_code() { return c()?.code ?? null; }, get category_name() { return c()?.name_th ?? null; } };
  }
  rpc(fn: string, a: Record<string, unknown>): { status: number; body: unknown } | null {
    this.calls.push({ fn, args: a });
    const missing = { status: 404, body: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache`, details: null, hint: null } };
    const err = (message: string) => ({ status: 400, body: { code: 'P0001', message, details: null, hint: null } });
    switch (fn) {
      case 'product_categories_list': return this.installed ? { status: 200, body: this.cats } : missing;
      case 'product_category_save': {
        if (!this.installed) return missing;
        const patch = a.p_patch as Partial<Cat>;
        if (!a.p_id) {
          if (this.cats.some((c) => c.code.toLowerCase() === String(patch.code).toLowerCase())) return err(`CODE_TAKEN: ${patch.code} is already used`);
          const c = mk({ id: `bbbbbbbb-0000-4000-8000-${String(this.cats.length).padStart(12, '0')}`, code: String(patch.code), name_th: String(patch.name_th), name_en: patch.name_en || null, parent_id: patch.parent_id ?? null, is_group: !!patch.is_group });
          this.cats.push(c); return { status: 200, body: c };
        }
        const c = this.cats.find((x) => x.id === a.p_id)!; Object.assign(c, patch); return { status: 200, body: c };
      }
      case 'product_category_set_active': {
        const c = this.cats.find((x) => x.id === a.p_id)!;
        if (!a.p_active && !String(a.p_reason ?? '').trim()) return err('REASON_REQUIRED: say why the category is deactivated');
        c.is_active = !!a.p_active; return { status: 200, body: c };
      }
      case 'sku_changes_since': return { status: 200, body: { cursor: 1, full: a.p_cursor == null, rows: this.rows.map((r) => ({ ...r, category_code: r.category_code, category_name: r.category_name })) } };
      case 'sku_set_details': {
        const r = this.rows.find((x) => x.sku_code === a.p_code)!;
        const patch = a.p_patch as { category_id?: string };
        if (patch.category_id) {
          const c = this.cats.find((x) => x.id === patch.category_id);
          if (!c) return err(`NOT_FOUND: category ${patch.category_id} does not exist`);
          if (!c.is_active) return err(`CATEGORY_INACTIVE: ${c.code} is inactive and cannot be chosen`);
          r.category_id = c.id;
        }
        return { status: 200, body: { ...r, category_code: r.category_code, category_name: r.category_name } };
      }
      default: return null;
    }
  }
  async install(page: Page) {
    await page.route(`https://${HOST}/rest/v1/rpc/**`, async (route: Route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const fn = new URL(req.url()).pathname.slice('/rest/v1/rpc/'.length);
      let args: Record<string, unknown> = {}; try { args = JSON.parse(req.postData() || '{}'); } catch { /* none */ }
      const r = this.rpc(fn, args);
      if (!r) return route.fallback();
      return route.fulfill({ status: r.status, contentType: 'application/json', headers: cors, body: JSON.stringify(r.body) });
    });
  }
}

async function boot(page: Page, o: { installed?: boolean } = {}) {
  const shop = new FakeShop();
  shop.profile.role = 'SUPER_ADMIN'; shop.profile.display_name = 'Owner';
  const fc = new FakeCategories(); fc.installed = o.installed ?? true;
  await shop.install(page); await fc.install(page);
  await page.addInitScript(() => { try { localStorage.setItem('bizops.lang', 'en'); } catch { /* ignore */ } });
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  return { fc, errors };
}

test('Categories page: groups and categories, create one under a group, deactivate with a reason', async ({ page }) => {
  const { fc, errors } = await boot(page);
  await page.goto('/#/categories');
  await expect(page.getByRole('row', { name: /^▸ POD \/ vape/ })).toBeVisible();        // the group row (English screen: the English name)
  await expect(page.getByRole('row', { name: /^Puff/ })).toContainText('POD / vape');     // its category shows the group
  await expect(page.getByRole('row', { name: /Kratom drink/ })).toBeVisible();
  await page.getByRole('button', { name: 'New category' }).click();
  const modal = page.locator('.modal');
  await modal.getByRole('textbox', { name: 'Code' }).fill('Disposable');
  await modal.getByRole('textbox', { name: 'Name (Thai)' }).fill('แบบใช้แล้วทิ้ง');
  await modal.getByRole('combobox', { name: 'Group' }).selectOption(POD);
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('row', { name: /แบบใช้แล้วทิ้ง/ })).toBeVisible();
  expect(fc.calls.find((c) => c.fn === 'product_category_save')!.args).toMatchObject({ p_id: null, p_patch: { code: 'Disposable', name_th: 'แบบใช้แล้วทิ้ง', parent_id: POD, is_group: false } });

  // deactivating asks for a reason, says the products keep it, and sends the reason
  await page.getByRole('row', { name: /^Puff/ }).getByRole('switch').click();
  await expect(modal).toContainText('1 products use this category');
  await modal.getByRole('textbox').fill('Merged into Disposable');
  await modal.getByRole('button', { name: 'Deactivate' }).click();
  await expect.poll(() => fc.cats.find((c) => c.id === PUFF)!.is_active).toBe(false);
  expect(fc.calls.find((c) => c.fn === 'product_category_set_active')!.args).toMatchObject({ p_id: PUFF, p_active: false, p_reason: 'Merged into Disposable' });
  await expect(page.getByRole('row', { name: /^Puff/ })).toHaveCount(0);                   // the default view shows active ones
  await page.getByRole('combobox', { name: 'Status' }).selectOption('inactive');
  await expect(page.getByRole('row', { name: /^Puff/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Products: the category comes from the registry, is filtered, and is changed only through the registered list', async ({ page }) => {
  const { fc, errors } = await boot(page);
  await page.goto('/#/products');
  const grape = page.getByRole('row', { name: /BRAND Grape 20000/ });
  await expect(grape).toContainText('Puff');
  await page.getByRole('combobox', { name: 'Category' }).selectOption(KRATOM);
  await expect(page.getByRole('row', { name: /BRAND Grape 20000/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Kratom bottle/ })).toBeVisible();
  await page.getByRole('combobox', { name: 'Category' }).selectOption(POD);                // a group shows its categories' products
  await expect(page.getByRole('row', { name: /BRAND Grape 20000/ })).toBeVisible();

  await page.getByRole('row', { name: /BRAND Grape 20000/ }).click();
  const drawer = page.locator('aside.drawer');
  const select = drawer.getByTestId('category-select');
  await expect(select).toHaveValue(PUFF);
  expect(await drawer.getByRole('textbox', { name: 'Category' }).count()).toBe(0);           // never a free-text box
  const options = await select.locator('option').allInnerTexts();
  expect(options.join('|')).not.toContain('POD / บุหรี่ไฟฟ้า');                               // a group is not choosable
  await select.selectOption(COIL);
  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => fc.calls.filter((c) => c.fn === 'sku_set_details').at(-1)?.args).toMatchObject({ p_code: 'FG-000001', p_patch: { category_id: COIL } });
  await expect(page.getByRole('row', { name: /BRAND Grape 20000/ })).toContainText('Coil');
  expect(errors).toEqual([]);
});

test('a database without the migration: Products keeps the old field, the Categories page explains', async ({ page }) => {
  const { errors } = await boot(page, { installed: false });
  await page.goto('/#/categories');
  await expect(page.getByText(/not installed in the database yet/)).toBeVisible();
  await page.goto('/#/products');
  await page.getByRole('row', { name: /BRAND Grape 20000/ }).click();
  const drawer = page.locator('aside.drawer');
  await expect(drawer.getByRole('textbox', { name: 'Category' })).toBeVisible();
  await expect(drawer.getByTestId('category-select')).toHaveCount(0);
  expect(errors).toEqual([]);
});
