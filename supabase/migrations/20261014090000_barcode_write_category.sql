-- Audit 2026-09-13 finding #33: catalog_write_provider_revision (20260919090100) never wrote
-- category, so every OFF/FDC-branded barcode scan was permanently category-less and her
-- banned_categories rule (default 'simple_sugars') could never block a scanned item. category is
-- not a new column — catalog_food_revisions has carried it since the shell (20260911000100) and
-- the bulk FDC import already writes it (scripts/import-fdc.py) — this only teaches the
-- request-path RPC to do the same for a provider draft that names one (offToRevision /
-- fdcBrandedToRevision, lib/catalog/off-map.ts). CREATE OR REPLACE keeps the function's existing
-- grants (20260919090100's revoke/grant block), so they are not repeated here.
--
-- Every other line of the function is byte-for-byte 20260919090100's version.
create or replace function catalog_write_provider_revision(
  p_user_id uuid, p_source text, p_gtin14 text, p_draft jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_label    text;
  v_ver_id   bigint;
  v_food_id  bigint;
  v_rev_id   bigint;
  v_desc     text;
  v_brand    text;
  v_category text;
  v_pub      timestamptz;
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;
  if p_source not in ('off','fdc_branded') then
    raise exception 'bad_source' using errcode = '22023';
  end if;
  if p_gtin14 is null or p_gtin14 !~ '^[0-9]{14}$' then
    raise exception 'bad_gtin' using errcode = '22023';
  end if;
  if p_draft->'per100g' is null then raise exception 'bad_draft' using errcode = '22023'; end if;

  v_desc     := coalesce(nullif(trim(p_draft->>'description'), ''), 'Barcode ' || p_gtin14);
  v_brand    := nullif(trim(coalesce(p_draft->>'brand', '')), '');
  v_category := nullif(trim(coalesce(p_draft->>'category', '')), '');
  v_pub      := coalesce((p_draft->>'publishedAt')::timestamptz, now());
  v_label    := p_source || '-' || to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');

  insert into catalog_versions (source, version_label, is_active)
    values (p_source, v_label, false) on conflict (source, version_label) do nothing;
  select id into v_ver_id from catalog_versions
    where source = p_source and version_label = v_label;

  insert into catalog_foods (source, source_id) values (p_source, p_gtin14)
    on conflict (source, source_id) do nothing;
  select id into v_food_id from catalog_foods
    where source = p_source and source_id = p_gtin14;

  update catalog_food_revisions set is_active = false, valid_to = now()
   where catalog_food_id = v_food_id and is_active and catalog_version_id <> v_ver_id;

  insert into catalog_food_revisions (catalog_food_id, catalog_version_id, description, brand,
      category, quality_class, quality_flags, search_doc, content_hash, is_active, valid_from, valid_to)
  values (v_food_id, v_ver_id, v_desc, v_brand, v_category,
      coalesce(p_draft->>'qualityClass', 'crowd'),
      coalesce(array(select jsonb_array_elements_text(p_draft->'qualityFlags')), '{}'::text[]),
      catalog_search_doc(v_desc, v_brand, v_category),
      encode(sha256(convert_to(p_draft::text, 'UTF8')), 'hex'), true, now(), null)
  on conflict (catalog_food_id, catalog_version_id) do update
    set description = excluded.description, brand = excluded.brand, category = excluded.category,
        quality_class = excluded.quality_class, quality_flags = excluded.quality_flags,
        search_doc = excluded.search_doc, content_hash = excluded.content_hash,
        is_active = true, valid_from = now(), valid_to = null
  returning id into v_rev_id;

  delete from catalog_food_nutrients where food_revision_id = v_rev_id;
  insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
  select v_rev_id, kv.key, nullif(kv.value, 'null'::jsonb)::numeric
    from jsonb_each(p_draft->'per100g') kv
   where exists (select 1 from catalog_nutrients c where c.code = kv.key);

  delete from catalog_portions where food_revision_id = v_rev_id;
  insert into catalog_portions (food_revision_id, description, gram_weight, seq, is_default)
  select v_rev_id, p.value->>'description', (p.value->>'gramWeight')::numeric,
         p.ord::int, p.ord = 1
    from jsonb_array_elements(coalesce(p_draft->'portions', '[]'::jsonb))
         with ordinality as p(value, ord);

  -- seq 1 carries the product's verbatim ingredients_text; later rows carry their own fragment
  -- in `name` and no raw_text. resolveBarcode reads BarcodeMatch.ingredientsText back from it.
  delete from catalog_ingredients where food_revision_id = v_rev_id;
  insert into catalog_ingredients (food_revision_id, seq, name, allergen_tags, raw_text)
  select v_rev_id, (i.value->>'seq')::int, i.value->>'name',
         coalesce(array(select jsonb_array_elements_text(i.value->'allergenTags')), '{}'::text[]),
         case when (i.value->>'seq')::int = 1 then p_draft->>'ingredientsText' else null end
    from jsonb_array_elements(coalesce(p_draft->'ingredients', '[]'::jsonb)) as i(value);

  insert into catalog_barcodes (gtin14, catalog_food_id, source, published_at)
       values (p_gtin14, v_food_id, p_source, v_pub)
  on conflict (gtin14, catalog_food_id, source) do update set published_at = excluded.published_at;

  perform get_or_create_food_ref(p_user_id, 'catalog', v_food_id, null);

  return jsonb_build_object('catalog_food_id', v_food_id, 'revision_id', v_rev_id,
                            'version_label', v_label);
end; $$;
