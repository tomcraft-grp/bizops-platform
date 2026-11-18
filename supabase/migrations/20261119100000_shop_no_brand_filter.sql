-- FB-001018: "the brand filter has no kratom". The brand dropdown lists the values of the SKU master's brand column, and the kratom drinks have no brand (the SKU
-- master files them under a product type, not a brand), so the filter could never offer them. This adds a "no brand" choice to the customer shop's filter.
--
--   shop_facets()   gains one key, 'no_brand_count': how many sellable products have no brand. Nothing else changes, so an app that does not know the key keeps working.
--   shop_catalog()  accepts the filter value '__none__' in p_brand, meaning "products with no brand". Any other brand value filters exactly as before.
--
-- Both are replaced with CREATE OR REPLACE: their privileges stay as they are (authenticated only), no table, column, policy or data is touched.
-- Rollback: supabase/rollbacks/20261119100000_shop_no_brand_filter_down.sql (puts the two original functions back).

create or replace function public.shop_facets()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.shop_require_user();
  return jsonb_build_object(
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('code', x.category, 'name_th', g.name_th, 'name_en', g.name_en, 'count', x.n,
        'image_url', coalesce(public.shop_image_url(g.image_path), x.img)) order by coalesce(g.sort_order, 100), x.category), '[]'::jsonb)
      from (select v.category, count(*) n, (array_agg(v.image_urls[1] order by v.featured desc, v.sku_seq) filter (where v.image_urls[1] is not null))[1] img
            from public.shop_sellable v group by v.category) x
      left join public.shop_categories g on g.code = x.category),
    'brands', (select coalesce(jsonb_agg(jsonb_build_object('brand', b.brand, 'count', b.n) order by b.n desc, b.brand), '[]'::jsonb)
      from (select v.brand, count(*) n from public.shop_sellable v where v.brand is not null group by v.brand) b),
    'no_brand_count', (select count(*) from public.shop_sellable v where v.brand is null));
end $$;

create or replace function public.shop_catalog(p_search text default null, p_category text default null, p_brand text default null,
  p_sort text default 'recommended', p_limit integer default 24, p_offset integer default 0, p_featured boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare lim integer := least(greatest(coalesce(p_limit, 24), 1), 60); off integer := greatest(coalesce(p_offset, 0), 0);
        q text := nullif(btrim(coalesce(p_search, '')), ''); pat text; res jsonb;
begin
  perform public.shop_require_user();
  if q is not null then
    if length(q) > 80 then q := left(q, 80); end if;
    pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  with m as (
    select v.* from public.shop_sellable v
    where (q is null or v.sku_code ilike pat or v.name_full ilike pat or v.name_th ilike pat or v.name_en ilike pat or v.brand ilike pat or v.barcode ilike pat)
      and (nullif(p_category, '') is null or v.category = p_category)
      and (nullif(p_brand, '') is null or case when p_brand = '__none__' then v.brand is null else v.brand = p_brand end)
      and (not coalesce(p_featured, false) or v.featured)),
  pg as (
    select * from m
    order by
      case when p_sort = 'price_asc' then price end asc,
      case when p_sort = 'price_desc' then price end desc,
      case when p_sort = 'newest' then sku_seq end desc,
      case when p_sort = 'name' then name_full end asc,
      case when coalesce(p_sort, 'recommended') = 'recommended' then featured end desc,
      available desc, sort_order, sku_seq
    limit lim offset off)
  select jsonb_build_object('total', (select count(*) from m),
    'items', coalesce((select jsonb_agg(public.shop_item_json(pg::public.shop_sellable)) from pg), '[]'::jsonb)) into res;
  return res;
end $$;
